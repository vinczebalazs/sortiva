import { and, eq, inArray, sql } from 'drizzle-orm'
import { ingestionJobs, jobSteps, type Db } from '@sortiva/db'

export type JobStepRow = typeof jobSteps.$inferSelect
export type JobStepName = JobStepRow['step']
export type JobStepState = JobStepRow['state']

/**
 * main §14.3.1 — "Steps declare their dependencies (e.g. `distill` requires
 * `catalog_sync = succeeded`); the scheduler only dispatches steps whose
 * dependencies are met, which is what makes resume-from-anywhere free:
 * restarting a job just means re-dispatching non-succeeded steps."
 *
 * The order below is main §6's numbered ingestion steps. The one non-obvious
 * edge: `gsc_connect` "runs right after keyword/competitor discovery and before
 * confirmation" (§6.7) but §14.3.1 says it "never blocks
 * `awaiting_confirmation`" — so it *depends on* `keywords_competitors` while
 * `awaiting_confirmation` does **not** depend on it. Skipping GSC leaves the
 * account in Limited Intelligence mode (§7.11) and onboarding continues.
 */
export const STEP_DEPENDENCIES: Readonly<Record<JobStepName, readonly JobStepName[]>> = {
  detect: [],
  oauth_wait: ['detect'],
  catalog_sync: ['oauth_wait'],
  distill: ['catalog_sync'],
  family_group: ['distill'],
  persona: ['family_group'],
  keywords_competitors: ['persona'],
  gsc_connect: ['keywords_competitors'],
  awaiting_confirmation: ['keywords_competitors'],
}

export const ALL_STEPS = Object.keys(STEP_DEPENDENCIES) as JobStepName[]

/** A step is finished — for dependency purposes — when it succeeded or was skipped. */
const SATISFIED: readonly JobStepState[] = ['succeeded', 'skipped']

/** States a worker may claim from: never-run, or scheduled for another attempt. */
const CLAIMABLE: readonly JobStepState[] = ['pending', 'failed_retryable']

export async function createRun(
  db: Db,
  accountId: string,
  runId: string,
  steps: readonly JobStepName[] = ALL_STEPS,
): Promise<{ jobId: string }> {
  const [job] = await db.insert(ingestionJobs).values({ accountId, runId }).returning()
  if (!job) throw new Error('failed to create ingestion job')
  await db.insert(jobSteps).values(
    steps.map((step) => ({
      jobId: job.id,
      step,
      // Replaced by the derived key when the step is first executed (§14.3.2);
      // a placeholder keeps the column NOT NULL without inventing a random key.
      idempotencyKey: `unassigned:${job.id}:${step}`,
    })),
  )
  return { jobId: job.id }
}

/**
 * main §14.3.1 — steps whose dependencies are met and which are not already
 * finished or running. Re-dispatching a job is just calling this again.
 */
export async function dispatchableSteps(db: Db, jobId: string): Promise<JobStepRow[]> {
  const rows = await db.select().from(jobSteps).where(eq(jobSteps.jobId, jobId))
  const byName = new Map(rows.map((row) => [row.step, row]))
  const now = Date.now()

  return rows.filter((row) => {
    if (!CLAIMABLE.includes(row.state)) return false
    // §14.3.5 — a retryable failure is not dispatchable until its backoff elapses.
    if (row.nextAttemptAt && row.nextAttemptAt.getTime() > now) return false
    return STEP_DEPENDENCIES[row.step].every((dep) => {
      const depRow = byName.get(dep)
      return depRow !== undefined && SATISFIED.includes(depRow.state)
    })
  })
}

/**
 * main §14.3.1 — "Transitions are guarded DB updates (`UPDATE ... WHERE state =
 * 'expected'`); a worker whose guard matches zero rows stops immediately —
 * someone else owns the step." (constitution invariants 15 and 18)
 *
 * Returns `undefined` on a zero-row guard. Callers must stop, not retry.
 */
export async function guardedTransition(
  db: Db,
  stepId: string,
  from: JobStepState | readonly JobStepState[],
  to: JobStepState,
  patch: Partial<Omit<typeof jobSteps.$inferInsert, 'id' | 'jobId' | 'step' | 'state'>> = {},
): Promise<JobStepRow | undefined> {
  const expected = Array.isArray(from) ? from : [from as JobStepState]
  const [row] = await db
    .update(jobSteps)
    .set({ ...patch, state: to, updatedAt: new Date() })
    .where(and(eq(jobSteps.id, stepId), inArray(jobSteps.state, [...expected])))
    .returning()
  return row
}

/** Guarded claim: pending|failed_retryable → running, incrementing attempts. */
export async function claimStep(
  db: Db,
  stepId: string,
  idempotencyKey: string,
): Promise<JobStepRow | undefined> {
  const [row] = await db
    .update(jobSteps)
    .set({
      state: 'running',
      idempotencyKey,
      attempts: sql`${jobSteps.attempts} + 1`,
      startedAt: new Date(),
      nextAttemptAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(jobSteps.id, stepId), inArray(jobSteps.state, [...CLAIMABLE])))
    .returning()
  return row
}

/**
 * main §14.3.2 — "Completed keys are stored with their output reference; a
 * worker seeing a completed key returns the stored output without executing.
 * This makes the *cache the ledger*: 'have I done this work' and 'where is the
 * result' are the same lookup."
 */
export async function lookupCompletedKey(
  db: Db,
  idempotencyKey: string,
): Promise<{ outputRef: unknown } | undefined> {
  const [row] = await db
    .select({ outputRef: jobSteps.outputRef })
    .from(jobSteps)
    .where(and(eq(jobSteps.idempotencyKey, idempotencyKey), eq(jobSteps.state, 'succeeded')))
    .limit(1)
  return row ? { outputRef: row.outputRef } : undefined
}

/**
 * main §14.3.4 — "any step that can exceed 60 seconds must checkpoint". The
 * cursor is committed on its own so a crash resumes from it, not from the start.
 */
export async function saveCheckpoint(db: Db, stepId: string, checkpoint: unknown): Promise<void> {
  await db
    .update(jobSteps)
    .set({ checkpoint: checkpoint as never, updatedAt: new Date() })
    .where(eq(jobSteps.id, stepId))
}

export async function readCheckpoint<T>(db: Db, stepId: string): Promise<T | undefined> {
  const [row] = await db
    .select({ checkpoint: jobSteps.checkpoint })
    .from(jobSteps)
    .where(eq(jobSteps.id, stepId))
    .limit(1)
  return (row?.checkpoint ?? undefined) as T | undefined
}

export async function getStep(db: Db, stepId: string): Promise<JobStepRow | undefined> {
  const [row] = await db.select().from(jobSteps).where(eq(jobSteps.id, stepId)).limit(1)
  return row
}

export async function findStep(
  db: Db,
  jobId: string,
  step: JobStepName,
): Promise<JobStepRow | undefined> {
  const [row] = await db
    .select()
    .from(jobSteps)
    .where(and(eq(jobSteps.jobId, jobId), eq(jobSteps.step, step)))
    .limit(1)
  return row
}

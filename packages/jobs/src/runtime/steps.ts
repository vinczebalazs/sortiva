import { and, eq, inArray, lt, or, sql } from 'drizzle-orm'
import { ingestionJobs, jobSteps, type Db } from '@sortiva/db'
import { StepOwnershipLost } from './errors'
import { leaseExpiryFor } from './lease'

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

/** Overrides the per-step lease from `lease.ts`; tests and the chaos scenario only. */
export interface LeaseOverride {
  now?: Date
  /** `null` disables reclaim entirely; a number forces that lease on every step. */
  leaseMs?: number | null
}

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
 * finished or owned by a live worker. Re-dispatching a job is just calling this
 * again.
 *
 * A `running` row past its lease counts as dispatchable. Without that rule a
 * step whose process died mid-flight is never offered to anyone again: it is not
 * `succeeded`, so §14.3.1's "re-dispatch the non-succeeded steps" ought to cover
 * it, but nothing could tell it apart from a step a live worker is working on.
 * Reclaiming is safe because §14.3.3's per-account lock already means one worker
 * at a time per account. See `lease.ts`.
 */
export async function dispatchableSteps(
  db: Db,
  jobId: string,
  lease: LeaseOverride = {},
): Promise<JobStepRow[]> {
  const rows = await db.select().from(jobSteps).where(eq(jobSteps.jobId, jobId))
  const byName = new Map(rows.map((row) => [row.step, row]))
  const at = lease.now ?? new Date()
  const now = at.getTime()

  return rows.filter((row) => {
    if (!CLAIMABLE.includes(row.state) && !isReclaimable(row, at, lease.leaseMs)) return false
    // §14.3.5 — a retryable failure is not dispatchable until its backoff elapses.
    if (row.nextAttemptAt && row.nextAttemptAt.getTime() > now) return false
    return STEP_DEPENDENCIES[row.step].every((dep) => {
      const depRow = byName.get(dep)
      return depRow !== undefined && SATISFIED.includes(depRow.state)
    })
  })
}

/**
 * True when this row is `running` but its lease has expired, i.e. the worker
 * that claimed it is presumed dead. `startedAt` is stamped by `claimStep`; a
 * `running` row without one is left alone rather than guessed at.
 */
export function isReclaimable(
  row: Pick<JobStepRow, 'step' | 'state' | 'startedAt'>,
  now: Date = new Date(),
  overrideMs?: number | null,
): boolean {
  if (row.state !== 'running' || !row.startedAt) return false
  const expiry = leaseExpiryFor(row.step, now, overrideMs)
  return expiry !== null && row.startedAt.getTime() < expiry.getTime()
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

/**
 * Guarded claim: pending|failed_retryable → running, incrementing attempts.
 *
 * `expiredBefore` additionally allows a `running` row whose `started_at` is
 * older than that instant — the abandoned-step case above. It stays one guarded
 * UPDATE, so two workers racing to reclaim the same row still produce exactly
 * one winner: the winner's own `started_at` refreshes the lease and the loser's
 * guard matches zero rows.
 */
export async function claimStep(
  db: Db,
  stepId: string,
  idempotencyKey: string,
  options: { expiredBefore?: Date | null } = {},
): Promise<JobStepRow | undefined> {
  const claimable = inArray(jobSteps.state, [...CLAIMABLE])
  const expiredBefore = options.expiredBefore ?? null
  const guard = expiredBefore
    ? or(claimable, and(eq(jobSteps.state, 'running'), lt(jobSteps.startedAt, expiredBefore)))
    : claimable

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
    .where(and(eq(jobSteps.id, stepId), guard))
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
 *
 * Guarded on `running` like every other write in this file (§14.3.1): a worker
 * that has lost the step — because its lease expired and someone reclaimed it —
 * must not overwrite the live owner's cursor with its own stale one, which would
 * rewind the new owner's progress.
 */
export async function saveCheckpoint(db: Db, stepId: string, checkpoint: unknown): Promise<void> {
  const [row] = await db
    .update(jobSteps)
    .set({ checkpoint: checkpoint as never, updatedAt: new Date() })
    .where(and(eq(jobSteps.id, stepId), eq(jobSteps.state, 'running')))
    .returning({ id: jobSteps.id })
  if (!row) throw new StepOwnershipLost(stepId)
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

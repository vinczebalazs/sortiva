import { and, eq, inArray, lt, or, sql } from 'drizzle-orm'
import { ingestionJobs, jobSteps, type Db } from '@sortiva/db'
import { StepOwnershipLost } from './errors'
import { leaseExpiryFor } from './lease'

export type JobStepRow = typeof jobSteps.$inferSelect
export type JobStepName = JobStepRow['step']
export type JobStepState = JobStepRow['state']

/**
 * Which steps have to have finished before another may start — `distill`
 * cannot run until `catalog_sync` has succeeded, and so on. Declaring it this
 * way is what makes resume-from-anywhere free: restarting a run just means
 * offering the non-succeeded steps again.
 *
 * The one non-obvious edge: `gsc_connect` runs right after keyword and
 * competitor discovery, so it *depends on* `keywords_competitors` — but
 * `awaiting_confirmation` deliberately does **not** depend on it. A merchant who
 * skips Search Console must still be able to finish onboarding; they simply
 * continue in Limited Intelligence mode.
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
      // Replaced by the derived key when the step is first executed. A
      // placeholder keeps the column NOT NULL without inventing a random key,
      // which would defeat the point of deriving it from the inputs.
      idempotencyKey: `unassigned:${job.id}:${step}`,
    })),
  )
  return { jobId: job.id }
}

/**
 * Steps whose dependencies are met and which are not already finished or owned
 * by a live worker. Re-dispatching a run is just calling this again.
 *
 * A `running` row past its lease counts as dispatchable. Without that rule a
 * step whose process died mid-flight is never offered to anyone again: it is
 * not `succeeded`, so it ought to be re-dispatched, but nothing could tell it
 * apart from a step a live worker is genuinely working on. Reclaiming is safe
 * because the per-account lock already means one worker at a time per account.
 * See `lease.ts`.
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
    // A retryable failure is not dispatchable until its backoff has elapsed.
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
 * Every state change is an `UPDATE ... WHERE state = 'expected'`, so two
 * workers handed the same step cannot both proceed — whichever loses the race
 * matches zero rows.
 *
 * Returns `undefined` on a zero-row guard. Callers must stop, not retry: the
 * step now belongs to someone else.
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
 * The "have I already done this work" lookup used to live here, reading
 * `job_steps WHERE idempotency_key = $1 AND state = 'succeeded'`. It reads
 * `idempotency_ledger` now (`ledger.ts`): a job row cascades from its run and
 * from the account, so losing it let a redelivered message re-run — and re-bill
 * — work that was already done (audit T0.4 [major]).
 *
 * `job_steps.idempotency_key` stays: the dead-letter entry carries it, and it
 * is how an operator ties a stranded step to its ledger record. It is no longer
 * the *evidence* that the work happened.
 */

/**
 * Any step that can run past a minute saves its position here. The cursor is
 * committed on its own so a crash resumes from it rather than from the start.
 *
 * Guarded on `running` like every other write in this file: a worker
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

/**
 * The run a store's onboarding is being carried out by.
 *
 * The domain claim writes the run and its steps and pushes nothing onto the
 * queue, so this is how anything that arrives later — the OAuth callback, a
 * sweep — finds the work already waiting rather than starting a second
 * onboarding beside it.
 */
export async function findRunForAccount(
  db: Db,
  accountId: string,
): Promise<{ jobId: string; runId: string } | undefined> {
  const [row] = await db
    .select({ id: ingestionJobs.id, runId: ingestionJobs.runId })
    .from(ingestionJobs)
    .where(and(eq(ingestionJobs.accountId, accountId), eq(ingestionJobs.status, 'running')))
    .orderBy(ingestionJobs.startedAt)
    .limit(1)
  return row ? { jobId: row.id, runId: row.runId } : undefined
}

/**
 * Ends a run that has nothing left to do — a store we cannot serve.
 *
 * The remaining steps become `skipped` rather than staying `pending`, because
 * the progress screen renders these rows directly and a merchant parked on an
 * unsupported platform should not be left watching seven steps that will never
 * start.
 */
export async function closeRunAsSkipped(db: Db, jobId: string): Promise<number> {
  const rows = await db
    .update(jobSteps)
    .set({ state: 'skipped', updatedAt: new Date() })
    .where(and(eq(jobSteps.jobId, jobId), inArray(jobSteps.state, ['pending'])))
    .returning({ id: jobSteps.id })
  await db
    .update(ingestionJobs)
    .set({ status: 'succeeded', finishedAt: new Date() })
    .where(and(eq(ingestionJobs.id, jobId), eq(ingestionJobs.status, 'running')))
  return rows.length
}

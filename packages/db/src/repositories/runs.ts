import { and, desc, eq, inArray, isNotNull, lte } from 'drizzle-orm'
import type { Db } from '../client'
import { ingestionJobs, jobSteps } from '../schema'
import type { AccountScope, SystemScope } from '../scope'

export type IngestionJobRow = typeof ingestionJobs.$inferSelect
export type JobStepRow = typeof jobSteps.$inferSelect

/**
 * The onboarding run a store is currently in the middle of, and the individual
 * steps of it.
 *
 * Needed outside the worker because two of the steps are things the *merchant*
 * does rather than things a job does — connecting Search Console, or saying they
 * would rather not. The request that carries that answer has to be able to move
 * the step it answers, and it cannot reach a table without naming the store.
 */

export async function findActiveIngestionRun(
  db: Db,
  scope: AccountScope,
): Promise<IngestionJobRow | undefined> {
  const [row] = await db
    .select()
    .from(ingestionJobs)
    .where(and(eq(ingestionJobs.accountId, scope.accountId), eq(ingestionJobs.status, 'running')))
    // Newest first: a store that somehow has two open runs is answering about
    // the one it is looking at, which is the one that started last.
    .orderBy(desc(ingestionJobs.startedAt))
    .limit(1)
  return row
}

/**
 * The run the progress screen (ui §3.2) reads, whatever its status.
 *
 * Unlike `findActiveIngestionRun`, this does not stop at `running`: the
 * stepper stays on screen for a moment after the last step succeeds, and a
 * merchant re-opening the tab after it finished should see the finished
 * stepper, not a missing run.
 */
export async function findLatestIngestionRun(
  db: Db,
  scope: AccountScope,
): Promise<IngestionJobRow | undefined> {
  const [row] = await db
    .select()
    .from(ingestionJobs)
    .where(eq(ingestionJobs.accountId, scope.accountId))
    .orderBy(desc(ingestionJobs.startedAt))
    .limit(1)
  return row
}

/**
 * Every step of one run. The `jobId` itself has to come from an
 * account-scoped read first (`findLatestIngestionRun` above) — this does not
 * check ownership on its own, the same trade `dispatchableSteps` in
 * `packages/jobs` already makes for the same table.
 */
export async function listJobStepsForRun(db: Db, jobId: string): Promise<JobStepRow[]> {
  return db.select().from(jobSteps).where(eq(jobSteps.jobId, jobId))
}

/**
 * One named step of one of this account's runs. Joined back through
 * `ingestion_jobs` rather than trusted from the caller, because `job_steps` has
 * no account column of its own — without the join, a step id from anywhere would
 * be readable by anyone.
 */
export async function findAccountJobStep(
  db: Db,
  scope: AccountScope,
  jobId: string,
  step: JobStepRow['step'],
): Promise<JobStepRow | undefined> {
  const [row] = await db
    .select({ step: jobSteps })
    .from(jobSteps)
    .innerJoin(ingestionJobs, eq(jobSteps.jobId, ingestionJobs.id))
    .where(
      and(
        eq(jobSteps.jobId, jobId),
        eq(jobSteps.step, step),
        eq(ingestionJobs.accountId, scope.accountId),
      ),
    )
    .limit(1)
  return row?.step
}

/**
 * Moves one step of one of this account's runs, but only if it is still in a
 * state we expect. Two tabs answering the same question cannot both proceed:
 * whichever loses matches no rows and gets `undefined`, which callers read as
 * "somebody else already answered this" rather than as a failure.
 *
 * Joined through `ingestion_jobs` for the same reason as the read above:
 * `job_steps` carries no account of its own.
 */
export async function transitionAccountJobStep(
  db: Db,
  scope: AccountScope,
  input: {
    jobId: string
    step: JobStepRow['step']
    from: readonly JobStepRow['state'][]
    to: JobStepRow['state']
  },
): Promise<JobStepRow | undefined> {
  const step = await findAccountJobStep(db, scope, input.jobId, input.step)
  if (!step) return undefined
  const [row] = await db
    .update(jobSteps)
    .set({ state: input.to, updatedAt: new Date() })
    .where(and(eq(jobSteps.id, step.id), inArray(jobSteps.state, [...input.from])))
    .returning()
  return row
}


/**
 * Makes the steps that stopped because Shopify refused our token due again.
 *
 * Narrow on purpose. A merchant reconnecting their store is saying one thing —
 * "the token works again" — and it must revive exactly the work that stopped
 * for that reason. A step that failed terminally for its own reasons stays
 * failed, because nothing about a new token makes it more likely to succeed.
 *
 * The attempt counter is reset with it: the old attempts were all spent against
 * a token that could not work, and counting them against the new one would
 * exhaust the retries before the first real try.
 */
export async function resumeStepsAfterReauth(db: Db, jobId: string): Promise<number> {
  const rows = await db
    .update(jobSteps)
    .set({ state: 'pending', attempts: 0, nextAttemptAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(jobSteps.jobId, jobId),
        eq(jobSteps.state, 'failed_terminal'),
        eq(jobSteps.lastErrorClass, 'shopify_token_invalid'),
      ),
    )
    .returning({ id: jobSteps.id })
  return rows.length
}

/**
 * Runs that asked to be tried again and nobody came back for.
 *
 * When a step fails in a way worth retrying, the runtime stamps the time to try
 * again on the row and stops. Something then has to ask for that run to take
 * its next step once that time passes — and until the sweep that calls this
 * existed, nothing did. A store could stop halfway through onboarding, show
 * "we'll retry automatically" on the progress screen, and sit there for ever.
 *
 * The condition is deliberately narrow: a step that is waiting for a **person**
 * — the Shopify consent screen, the profile confirmation — is also sitting
 * still, and sweeping those would queue a job every five minutes for every
 * store that is politely waiting for its merchant. Only a scheduled retry whose
 * time has come counts as stalled here.
 *
 * The index migration `0000` created on `(state, next_attempt_at)` for exactly
 * this query had never been used by anything.
 */
export async function accountsWithRetryDue(
  db: Db,
  _scope: SystemScope,
  now: Date = new Date(),
  limit = 500,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ accountId: ingestionJobs.accountId })
    .from(jobSteps)
    .innerJoin(ingestionJobs, eq(ingestionJobs.id, jobSteps.jobId))
    .where(
      and(
        eq(ingestionJobs.status, 'running'),
        eq(jobSteps.state, 'failed_retryable'),
        isNotNull(jobSteps.nextAttemptAt),
        lte(jobSteps.nextAttemptAt, now),
      ),
    )
    .limit(limit)
  return rows.map((row) => row.accountId)
}

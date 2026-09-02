import { and, desc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../client'
import { ingestionJobs, jobSteps } from '../schema'
import type { AccountScope } from '../scope'

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

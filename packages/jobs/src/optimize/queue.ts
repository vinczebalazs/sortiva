import { sql } from 'drizzle-orm'
import type { Db } from '@sortiva/db'

/**
 * How an OPTIMIZE generation is asked for, and how the measurement of what it
 * achieved is booked for 28 days' time.
 *
 * Deliberately its own file with almost no imports, the same shape
 * `ingestion/queue.ts` and `sweeps/queue.ts` already use and for the same
 * reason: the request that starts a generation is made by an API route, and a
 * route that reaches for the whole background-jobs package drags the threshold
 * config's file loader into a bundle with no filesystem — the build fails while
 * every test passes.
 */

export const OPTIMIZE_GENERATE_TASK = 'optimize_recommendation_generate'

export interface OptimizeGeneratePayload {
  readonly accountId: string
  readonly opportunityId: string
}

/**
 * Asks for one page's recommendations to be written.
 *
 * The job key is the opportunity, so a merchant clicking twice — or a retried
 * request — produces one generation rather than two racing over the same page
 * and the same daily allowance. Derived from the input, never random, which is
 * what makes that true across separate requests as well as within one.
 */
export async function enqueueOptimizeGeneration(
  database: Db,
  payload: OptimizeGeneratePayload,
): Promise<void> {
  const task = OPTIMIZE_GENERATE_TASK
  const body = JSON.stringify(payload)
  const key = `${OPTIMIZE_GENERATE_TASK}:${payload.opportunityId}`
  await database.execute(
    sql`select graphile_worker.add_job(${task}, payload := ${body}::json, job_key := ${key}, job_key_mode := 'preserve_run_at')`,
  )
}

export const OPPORTUNITY_OUTCOME_MEASURE_TASK = 'opportunity_outcome_measure'

export interface OpportunityOutcomeMeasurePayload {
  readonly accountId: string
  readonly opportunityId: string
  /** When the merchant said they applied it — what the 28 days are counted from. */
  readonly appliedAt: string
}

/**
 * Books the measurement of what a recommendation achieved, for the first date
 * on which there is anything honest to say.
 *
 * The row is written the moment the merchant marks the work applied, rather
 * than by a sweep that later goes looking for applied opportunities, because
 * the queue is then the record: "we will look at this page again on the 28th"
 * exists as a fact, in one place, from the moment the promise is made.
 *
 * **Nothing runs it yet.** The handler is T7.1's, and the learning loop is
 * deferred out of v1 by the founder's decision of 2026-09-02. A queued job
 * whose task nobody has registered is not picked up and not lost: Graphile
 * only ever fetches tasks the running worker knows about, so these wait. The
 * cost of that is stated in DECISIONS.
 */
export async function enqueueOpportunityOutcomeMeasurement(
  database: Db,
  payload: OpportunityOutcomeMeasurePayload,
  runAt: Date,
): Promise<void> {
  const task = OPPORTUNITY_OUTCOME_MEASURE_TASK
  const body = JSON.stringify(payload)
  const key = `${OPPORTUNITY_OUTCOME_MEASURE_TASK}:${payload.opportunityId}`
  const at = runAt.toISOString()
  await database.execute(
    sql`select graphile_worker.add_job(${task}, payload := ${body}::json, job_key := ${key}, job_key_mode := 'preserve_run_at', run_at := ${at}::timestamptz)`,
  )
}

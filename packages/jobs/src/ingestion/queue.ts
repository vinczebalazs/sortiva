import { sql } from 'drizzle-orm'
import type { Db } from '@sortiva/db'

/**
 * How onboarding is asked to move, and nothing else.
 *
 * Deliberately its own file with almost no imports: the request that claims a
 * merchant's domain has to queue this, and a route that reaches for the whole
 * background-jobs package drags the threshold config's file loader into a bundle
 * that has no filesystem — the build fails while every test passes. Keeping the
 * request separate from the work it asks for is what lets a route make it.
 */

export const INGESTION_DISPATCH_TASK = 'ingestion_dispatch'

export interface IngestionDispatchPayload {
  readonly accountId: string
  /** The run to move. Looked up from the account's live run when absent. */
  readonly jobId?: string
}

/**
 * Asks for one store's onboarding to take its next step.
 *
 * Takes a transaction handle rather than opening its own: the claim queues this
 * in the same commit that writes the run, so a claim that rolls back cannot
 * leave a job pointing at a run that does not exist, and a claim that commits
 * cannot leave a merchant on a progress screen with nothing behind it.
 *
 * The job key is the account, so a merchant who submits the connect form twice
 * gets one nudge rather than two racing each other over the same steps. It is
 * derived from the input and never random, which is what makes that true across
 * separate requests as well as within one.
 */
export async function enqueueIngestionDispatch(
  database: Db,
  payload: IngestionDispatchPayload,
): Promise<void> {
  const task = INGESTION_DISPATCH_TASK
  const body = JSON.stringify(payload)
  const key = `${INGESTION_DISPATCH_TASK}:${payload.accountId}`
  await database.execute(
    sql`select graphile_worker.add_job(${task}, payload := ${body}::json, job_key := ${key}, job_key_mode := 'preserve_run_at')`,
  )
}

export const SHOPIFY_WEBHOOK_DRAIN_TASK = 'shopify_webhook_drain'

/**
 * Asks for the deliveries Shopify has made to be acted on.
 *
 * Queued by the receiver the moment it has written a delivery down and is about
 * to answer. The job key is the store, so a merchant editing forty products in a
 * burst produces one pass over the table rather than forty jobs racing each
 * other for the same rows.
 */
export async function enqueueShopifyWebhookDrain(
  database: Db,
  payload: { shopHandle: string },
): Promise<void> {
  const task = SHOPIFY_WEBHOOK_DRAIN_TASK
  const body = JSON.stringify(payload)
  const key = `${SHOPIFY_WEBHOOK_DRAIN_TASK}:${payload.shopHandle}`
  await database.execute(
    sql`select graphile_worker.add_job(${task}, payload := ${body}::json, job_key := ${key}, job_key_mode := 'preserve_run_at')`,
  )
}

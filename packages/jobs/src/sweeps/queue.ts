import { sql } from 'drizzle-orm'
import type { Db } from '@sortiva/db'

/**
 * How the lifecycle work is asked for, and nothing else.
 *
 * Deliberately its own file with almost no imports: the request that deletes an
 * account has to queue this, and a route that reaches for the whole
 * background-jobs package drags the queue runtime and the threshold config's
 * file loader into a bundle that has no filesystem — the build fails while every
 * test passes. Same shape as the ingestion queue file, for the same reason.
 */

export const ACCOUNT_CLOSE_TASK = 'account_close'

export interface AccountClosePayload {
  readonly accountId: string
}

/**
 * Asks for a deleted account's vendor relationships to be ended: the
 * subscription cancelled, and both access grants handed back.
 *
 * Takes a database handle rather than opening its own, so the deletion and this
 * request can commit together — a deletion that rolls back cannot leave a job
 * about to cancel a live merchant's subscription.
 *
 * The job key is the account, so a merchant who somehow submits twice gets one
 * job rather than two racing over the same vendor calls.
 */
export async function enqueueAccountClose(
  database: Db,
  payload: AccountClosePayload,
): Promise<void> {
  const task = ACCOUNT_CLOSE_TASK
  const body = JSON.stringify(payload)
  const key = `${ACCOUNT_CLOSE_TASK}:${payload.accountId}`
  await database.execute(
    sql`select graphile_worker.add_job(${task}, payload := ${body}::json, job_key := ${key}, job_key_mode := 'preserve_run_at')`,
  )
}

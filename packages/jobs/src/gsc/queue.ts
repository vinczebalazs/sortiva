import { sql } from 'drizzle-orm'
import type { Db } from '@sortiva/db'

/**
 * How the history import is asked for, and nothing else.
 *
 * Deliberately its own file with almost no imports: the request that finishes a
 * merchant's Search Console connection has to queue this, and a route that
 * reaches for the whole background-jobs package drags the threshold config's
 * file loader into a bundle that has no filesystem. Keeping the queue call
 * separate from the work it queues is what lets a route ask for it.
 */

export const GSC_BACKFILL_TASK = 'gsc_backfill'

export interface GscBackfillPayload {
  readonly accountId: string
  /** Chunks already written, as `start..end`. Absent on the first job of a chain. */
  readonly completed?: readonly string[]
  readonly rowsWritten?: number
}

/**
 * Queues the history import for one store. Keyed on the account, so a merchant
 * who reconnects twice in a minute gets one import rather than two racing each
 * other over the same rows.
 */
export async function enqueueGscBackfill(
  database: Db,
  payload: GscBackfillPayload,
): Promise<void> {
  const task = GSC_BACKFILL_TASK
  const body = JSON.stringify(payload)
  const key = `${GSC_BACKFILL_TASK}:${payload.accountId}`
  await database.execute(
    sql`select graphile_worker.add_job(${task}, payload := ${body}::json, job_key := ${key}, job_key_mode := 'preserve_run_at')`,
  )
}

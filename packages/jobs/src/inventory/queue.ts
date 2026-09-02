import { sql } from 'drizzle-orm'
import type { Db } from '@sortiva/db'

/**
 * How a re-read of a store's inventory is asked for, and nothing else.
 *
 * Deliberately its own file with almost no imports. A webhook route that reached
 * for the whole background-jobs package would drag the threshold config's file
 * loader into a bundle that has no filesystem, and the build would fail while
 * every test passed. Keeping the request separate from the work lets a route ask
 * for it.
 */

export const INVENTORY_SYNC_TASK = 'inventory_sync'

/** Which kinds of thing a re-read can name, matching the inventory's own vocabulary. */
export interface InventorySyncTarget {
  readonly kind: 'collection' | 'product' | 'page' | 'blog_article'
  readonly shopifyId: string
}

export interface InventorySyncPayload {
  readonly accountId: string
  /**
   * Where the last run stopped. Absent starts the store from the beginning;
   * meaningful only to the thing that produced it.
   */
  readonly cursor?: Readonly<Record<string, string>>
  /** Named things to re-read instead of walking the store. */
  readonly targets?: readonly InventorySyncTarget[]
}

/**
 * Asks for one store's inventory to be brought up to date.
 *
 * The job key is derived from the account and from what is being asked for, so
 * a burst of webhooks about the same page collapses into one job rather than a
 * queue of identical ones — while a full walk and a single page's re-read stay
 * separate pieces of work.
 */
export async function enqueueInventorySync(
  database: Db,
  payload: InventorySyncPayload,
): Promise<void> {
  const task = INVENTORY_SYNC_TASK
  const body = JSON.stringify(payload)
  const key = `${INVENTORY_SYNC_TASK}:${payload.accountId}:${jobKeySuffix(payload)}`
  await database.execute(
    sql`select graphile_worker.add_job(${task}, payload := ${body}::json, job_key := ${key}, job_key_mode := 'preserve_run_at')`,
  )
}

function jobKeySuffix(payload: InventorySyncPayload): string {
  if (!payload.targets || payload.targets.length === 0) return 'walk'
  return payload.targets
    .map((target) => `${target.kind}:${target.shopifyId}`)
    .sort()
    .join(',')
}

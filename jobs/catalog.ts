import { CONFIG } from '../core/config.ts'
import { refreshExistingContent, refreshProducts, syncCatalog, syncProgress } from '../core/learn/sync.ts'
import type { Db, DbClient } from '../db/pool.ts'
import type { Deps } from './deps.ts'
import { learnDeps } from './deps.ts'
import { idempotencyKey } from './runtime/keys.ts'
import { defineJob, enqueue } from './runtime/task.ts'

type SyncPayload = { storeId: number; reason: 'install' | 'sync_now' | 'nightly' | 'webhook_burst'; requestedAt: string }

export const catalogSync = defineJob<SyncPayload, Deps>({
  name: 'catalog_sync',
  storeId: (p) => p.storeId,
  idempotencyKey: (p) => idempotencyKey('catalog_sync', p.storeId, p.reason, { requestedAt: p.requestedAt }),
  run: async ({ deps, payload }) => syncCatalog(await learnDeps(deps, payload.storeId), payload.storeId),
})

const SYNC_REQUEST_LOCK = 0x53594e43
const syncJobKey = (storeId: number) => `catalog_sync:${storeId}`

async function syncQueued(db: DbClient, storeId: number): Promise<boolean> {
  const { rowCount } = await db.query('select 1 from graphile_worker.jobs where key = $1', [syncJobKey(storeId)])
  return Boolean(rowCount)
}

/** One sync per store at a time: a request while one is queued or running is refused, not stacked. */
export async function requestSync(pool: Db, storeId: number, reason: SyncPayload['reason'] = 'sync_now'): Promise<'started' | 'already_running'> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query('select pg_advisory_xact_lock($1, $2)', [SYNC_REQUEST_LOCK, storeId])
    if ((await syncQueued(client, storeId)) || (await syncProgress(pool, storeId)).running) {
      await client.query('commit')
      return 'already_running'
    }
    const { rows } = await client.query<{ now: Date }>('select now()')
    await enqueue(client, catalogSync.name, { storeId, reason, requestedAt: rows[0]!.now.toISOString() }, { jobKey: syncJobKey(storeId), jobKeyMode: 'unsafe_dedupe' })
    await client.query('commit')
    return 'started'
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

export async function startInitialLearn(db: DbClient, storeId: number): Promise<void> {
  const { rows } = await db.query<{ installed_at: Date }>('select installed_at from stores where id = $1', [storeId])
  await enqueue(db, catalogSync.name, { storeId, reason: 'install', requestedAt: rows[0]!.installed_at.toISOString() }, { jobKey: syncJobKey(storeId), jobKeyMode: 'unsafe_dedupe' })
}

export async function enqueueNightlySync(db: DbClient, storeId: number, localDate: string): Promise<void> {
  await enqueue(db, catalogSync.name, { storeId, reason: 'nightly', requestedAt: localDate }, { jobKey: `catalog_nightly:${storeId}:${localDate}`, jobKeyMode: 'unsafe_dedupe' })
}

/** Webhooks only say "look at this"; the deliveries are batched and the products re-read from the platform. */
export const catalogChanges = defineJob<{ storeId: number }, Deps>({
  name: 'catalog_changes',
  storeId: (p) => p.storeId,
  idempotencyKey: () => null,
  run: async ({ deps, payload: { storeId } }) => {
    const { rows } = await deps.pool.query<{ delivery_id: string; topic: string; subject: string | null }>(
      'select delivery_id, topic, subject from webhook_deliveries where store_id = $1 and processed_at is null order by received_at',
      [storeId],
    )
    if (!rows.length) return { deliveries: 0 }
    const markProcessed = () =>
      deps.pool.query('update webhook_deliveries set processed_at = now() where delivery_id = any($1)', [rows.map((r) => r.delivery_id)])

    if ((await syncQueued(deps.pool, storeId)) || rows.length > CONFIG.webhookBurstThreshold) {
      await requestSync(deps.pool, storeId, 'webhook_burst')
      await markProcessed()
      return { deliveries: rows.length, collapsedIntoSync: true }
    }
    const learn = await learnDeps(deps, storeId)
    const products = [...new Set(rows.filter((r) => r.topic.startsWith('products/') && r.subject).map((r) => r.subject!))]
    if (products.length) await refreshProducts(learn, storeId, products)
    if (rows.some((r) => r.topic.startsWith('collections/'))) await refreshExistingContent(learn, storeId)
    await markProcessed()
    return { deliveries: rows.length, products: products.length }
  },
})

export async function enqueueCatalogChanges(db: DbClient, storeId: number, debounceMs: number): Promise<void> {
  await enqueue(db, catalogChanges.name, { storeId }, { jobKey: `catalog_changes:${storeId}`, jobKeyMode: 'preserve_run_at', runAt: new Date(Date.now() + debounceMs) })
}

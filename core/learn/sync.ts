import { AccessLostError, PermissionLostError, type StoreConnector } from '../../connectors/types.ts'
import type { Db } from '../../db/pool.ts'
import { CONFIG, type Language } from '../config.ts'
import { BudgetExceededError } from '../errors.ts'
import type { Llm } from '../llm.ts'
import { StorePausedError, clearPermissionsLost, recordBudgetPause, recordPermissionLost } from '../status.ts'
import { markProductDeleted, markUnseenDeleted, replaceStorePages, upsertProduct } from './catalog.ts'
import { extractFacts, type ProductForFacts } from './facts.ts'
import { draftProfile, languageFromLocale } from './profile.ts'

export type LearnDeps = {
  db: Db
  llm: Llm
  connector: StoreConnector
  /** Called after each saved checkpoint; tests use it to crash or hold a run at a known point. */
  checkpoint?: (name: string, n: number) => void | Promise<void>
}

type Cursor = { startedAt: string; cursor: string | null; walked: boolean; page: number; done: number; total: number; phase: 'products' | 'facts' }

const checkpointKey = (storeId: number) => `catalog:${storeId}`

async function saveCheckpoint(db: Db, storeId: number, cursor: Cursor): Promise<void> {
  await db.query(
    `insert into job_checkpoints (key, store_id, cursor, updated_at) values ($1, $2, $3, now())
     on conflict (key) do update set cursor = excluded.cursor, updated_at = now()`,
    [checkpointKey(storeId), storeId, JSON.stringify(cursor)],
  )
}

/** Turns vendor refusals into a recorded pause with a reason the merchant sees. */
export async function pauseOn<T>(db: Db, storeId: number, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof PermissionLostError) {
      await recordPermissionLost(db, storeId, error.scope)
      throw new StorePausedError(storeId, 'permission')
    }
    if (error instanceof AccessLostError) {
      await recordPermissionLost(db, storeId, 'access')
      throw new StorePausedError(storeId, 'access')
    }
    if (error instanceof BudgetExceededError) {
      await recordBudgetPause(db, storeId)
      throw new StorePausedError(storeId, 'budget')
    }
    throw error
  }
}

export async function storeLanguage(db: Db, storeId: number): Promise<Language> {
  const { rows } = await db.query<{ language: Language | null; primary_locale: string | null }>(
    `select p.language, s.primary_locale from stores s left join store_profile p on p.store_id = s.id where s.id = $1`,
    [storeId],
  )
  return rows[0]?.language ?? languageFromLocale(rows[0]?.primary_locale ?? null) ?? 'en'
}

async function extractPendingFacts(deps: LearnDeps, storeId: number, cursor: Cursor): Promise<void> {
  const language = await storeLanguage(deps.db, storeId)
  const { rows } = await deps.db.query<ProductForFacts & { content_hash: string }>(
    `select id, title, product_type, vendor, options, tags, metafields, description_html, content_hash
     from products where store_id = $1 and deleted_at is null and content_hash is distinct from facts_hash order by id`,
    [storeId],
  )
  let n = 0
  for (const product of rows) {
    await extractFacts(deps.db, deps.llm, storeId, language, product)
    n++
    await saveCheckpoint(deps.db, storeId, { ...cursor, phase: 'facts', done: n, total: rows.length })
    await deps.checkpoint?.('facts_product', n)
  }
}

/** Reads the whole catalogue and the store's existing content, then brings fact sheets up to date. */
export async function syncCatalog(deps: LearnDeps, storeId: number): Promise<{ products: number; deleted: number }> {
  return pauseOn(deps.db, storeId, async () => {
    const { rows } = await deps.db.query<{ cursor: Cursor }>('select cursor from job_checkpoints where key = $1', [checkpointKey(storeId)])
    let cursor: Cursor = rows[0]?.cursor ?? {
      startedAt: (await deps.db.query<{ now: Date }>('select now()')).rows[0]!.now.toISOString(),
      cursor: null,
      walked: false,
      page: 0,
      done: 0,
      total: await deps.connector.productCount(),
      phase: 'products',
    }
    await saveCheckpoint(deps.db, storeId, cursor)

    let deleted = 0
    if (cursor.phase === 'products') {
      while (!cursor.walked) {
        const page = await deps.connector.productsPage(cursor.cursor, CONFIG.catalogPageSize)
        for (const product of page.items) await upsertProduct(deps.db, storeId, product)
        cursor = { ...cursor, cursor: page.nextCursor, walked: !page.nextCursor, page: cursor.page + 1, done: cursor.done + page.items.length }
        await saveCheckpoint(deps.db, storeId, cursor)
        await deps.checkpoint?.('catalog_page', cursor.page)
      }
      deleted = await markUnseenDeleted(deps.db, storeId, cursor.startedAt)
      await replaceStorePages(deps.db, storeId, await deps.connector.existingContent())
      cursor = { ...cursor, phase: 'facts', done: 0, total: 0 }
      await saveCheckpoint(deps.db, storeId, cursor)
    }
    await clearPermissionsLost(deps.db, storeId, ['read_products', 'read_content', 'access'])

    await extractPendingFacts(deps, storeId, cursor)
    await finishSetupStep(deps, storeId)
    await deps.db.query('update stores set catalog_synced_at = now() where id = $1', [storeId])
    await deps.db.query('delete from job_checkpoints where key = $1', [checkpointKey(storeId)])
    const count = await deps.db.query<{ n: number }>('select count(*)::int as n from products where store_id = $1 and deleted_at is null', [storeId])
    return { products: count.rows[0]!.n, deleted }
  })
}

/** Re-reads named products from the platform; the webhook only told us which ones to look at. */
export async function refreshProducts(deps: LearnDeps, storeId: number, platformIds: string[]): Promise<void> {
  await pauseOn(deps.db, storeId, async () => {
    for (const id of platformIds) {
      const product = await deps.connector.product(id)
      if (product) await upsertProduct(deps.db, storeId, product)
      else await markProductDeleted(deps.db, storeId, id)
    }
    await extractPendingFacts(deps, storeId, { startedAt: new Date().toISOString(), cursor: null, walked: true, page: 0, done: 0, total: 0, phase: 'facts' })
  })
}

export async function refreshExistingContent(deps: LearnDeps, storeId: number): Promise<void> {
  await pauseOn(deps.db, storeId, async () => replaceStorePages(deps.db, storeId, await deps.connector.existingContent()))
}

async function finishSetupStep(deps: LearnDeps, storeId: number): Promise<void> {
  const { rows } = await deps.db.query<{ setup_step: string; products: number; has_profile: boolean }>(
    `select s.setup_step,
            (select count(*)::int from products where store_id = s.id and deleted_at is null) as products,
            exists(select 1 from store_profile where store_id = s.id) as has_profile
     from stores s where s.id = $1`,
    [storeId],
  )
  const row = rows[0]!
  if (row.setup_step !== 'reading' && row.setup_step !== 'no_products') return
  if (row.products === 0) {
    await deps.db.query(`update stores set setup_step = 'no_products' where id = $1`, [storeId])
    return
  }
  if (!row.has_profile) await draftProfile(deps.db, deps.llm, storeId, await storeLanguage(deps.db, storeId))
  await deps.db.query(`update stores set setup_step = 'profile' where id = $1`, [storeId])
}

export type SyncProgress = { running: boolean; phase: 'products' | 'facts' | null; done: number; total: number; lastSyncedAt: Date | null }

// A checkpoint untouched for this long belongs to a run that died and will be retried by the queue.
const STALE_CHECKPOINT_MINUTES = 10

export async function syncProgress(db: Db, storeId: number): Promise<SyncProgress> {
  const { rows } = await db.query<{ cursor: Cursor | null; fresh: boolean | null; catalog_synced_at: Date | null }>(
    `select c.cursor, c.updated_at > now() - interval '${STALE_CHECKPOINT_MINUTES} minutes' as fresh, s.catalog_synced_at
     from stores s left join job_checkpoints c on c.key = 'catalog:' || s.id where s.id = $1`,
    [storeId],
  )
  const row = rows[0]
  const running = Boolean(row?.cursor && row.fresh)
  return {
    running,
    phase: running ? row!.cursor!.phase : null,
    done: running ? row!.cursor!.done : 0,
    total: running ? row!.cursor!.total : 0,
    lastSyncedAt: row?.catalog_synced_at ?? null,
  }
}

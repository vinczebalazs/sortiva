import type { ConnectorPage, ConnectorProduct } from '../../connectors/types.ts'
import type { DbClient } from '../../db/pool.ts'
import { stableHash } from '../hash.ts'
import { htmlToText } from './text.ts'

/** Only what fact extraction reads; a price or image change leaves it alone. */
export function contentHash(p: Pick<ConnectorProduct, 'title' | 'descriptionHtml' | 'options' | 'tags' | 'productType' | 'vendor' | 'metafields'>): string {
  return stableHash({ title: p.title, description: p.descriptionHtml, options: p.options, tags: p.tags, type: p.productType, vendor: p.vendor, metafields: p.metafields })
}

export async function upsertProduct(db: DbClient, storeId: number, p: ConnectorProduct): Promise<{ id: number; needsFacts: boolean }> {
  const { rows } = await db.query<{ id: number; content_hash: string; facts_hash: string | null }>(
    `insert into products (store_id, platform_id, handle, title, product_type, vendor, status, options, tags, images, collections,
                           metafields, price_min, price_max, currency, online_store_url, description_html, content_hash, last_seen_at, deleted_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, now(), null)
     on conflict (store_id, platform_id) do update set
       handle = excluded.handle, title = excluded.title, product_type = excluded.product_type, vendor = excluded.vendor,
       status = excluded.status, options = excluded.options, tags = excluded.tags, images = excluded.images,
       collections = excluded.collections, metafields = excluded.metafields, price_min = excluded.price_min,
       price_max = excluded.price_max, currency = excluded.currency, online_store_url = excluded.online_store_url,
       description_html = excluded.description_html, content_hash = excluded.content_hash, last_seen_at = now(), deleted_at = null
     returning id, content_hash, facts_hash`,
    [
      storeId, p.platformId, p.handle, p.title, p.productType, p.vendor, p.status,
      JSON.stringify(p.options), p.tags, JSON.stringify(p.images), JSON.stringify(p.collections), JSON.stringify(p.metafields),
      p.priceMin, p.priceMax, p.currency, p.onlineStoreUrl, p.descriptionHtml, contentHash(p),
    ],
  )
  const row = rows[0]!
  return { id: row.id, needsFacts: row.content_hash !== row.facts_hash }
}

export async function markProductDeleted(db: DbClient, storeId: number, platformId: string): Promise<void> {
  await db.query('update products set deleted_at = now() where store_id = $1 and platform_id = $2 and deleted_at is null', [storeId, platformId])
}

/** After a complete walk, anything not seen since the walk began is gone from the store. */
export async function markUnseenDeleted(db: DbClient, storeId: number, walkStartedAt: string): Promise<number> {
  const { rowCount } = await db.query(
    'update products set deleted_at = now() where store_id = $1 and deleted_at is null and last_seen_at < $2',
    [storeId, walkStartedAt],
  )
  return rowCount ?? 0
}

const EXCERPT_WORDS = 500

export async function replaceStorePages(db: DbClient, storeId: number, pages: ConnectorPage[]): Promise<void> {
  const started = new Date().toISOString()
  for (const page of pages) {
    const excerpt = htmlToText(page.excerptHtml).split(/\s+/).slice(0, EXCERPT_WORDS).join(' ')
    await db.query(
      `insert into store_pages (store_id, kind, platform_id, handle, url, title, excerpt, ours, last_seen_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now())
       on conflict (store_id, kind, platform_id) do update set
         handle = excluded.handle, url = excluded.url, title = excluded.title, excerpt = excluded.excerpt,
         ours = excluded.ours, last_seen_at = now()`,
      [storeId, page.kind, page.platformId, page.handle, page.url, page.title, excerpt, page.marker !== null],
    )
  }
  await db.query('delete from store_pages where store_id = $1 and last_seen_at < $2', [storeId, started])
}

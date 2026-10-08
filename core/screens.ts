import type { Db } from '../db/pool.ts'
import { CONFIG } from './config.ts'
import { syncProgress, type SyncProgress } from './learn/sync.ts'
import { pauseReason, thinState, type ThinState } from './status.ts'
import { homeQueue, type QueuedTopic, type Today } from './topics/queue.ts'

export type HomeState = {
  /** Search Console is not connected: the small "Limited" badge, not a banner. */
  limited: boolean
  thin: ThinState
  /** True while the first topic search after setup has not finished yet, unless a pause is holding it. */
  findingTopics: boolean
  /** The last topic search failed on our side; Home says so plainly instead of implying there is nothing to write. */
  topicsUnavailable: boolean
  /** Today's article could not be finished because a service failed; it is tried again tomorrow. */
  writeUnavailable: boolean
  publishHour: number
  deliveryMode: 'export' | 'auto_publish'
  today: Today
  upNext: QueuedTopic[]
}

export async function homeState(db: Db, storeId: number, now = new Date()): Promise<HomeState> {
  const { rows } = await db.query<{ limited: boolean; finding: boolean; failed: boolean; write_failed: boolean; publish_hour: number; delivery_mode: 'export' | 'auto_publish' }>(
    `select not exists (select 1 from gsc_connections g where g.store_id = s.id and g.connected_at is not null and g.disconnected_at is null) as limited,
            s.topics_discovered_at is null as finding, f.topics_failed_at is not null as failed, f.write_failed_at is not null as write_failed, s.publish_hour, s.delivery_mode
     from stores s join store_flags f on f.store_id = s.id where s.id = $1`,
    [storeId],
  )
  const queue = await homeQueue(db, storeId, now)
  return { limited: rows[0]!.limited, thin: await thinState(db, storeId), findingTopics: rows[0]!.finding && !rows[0]!.failed && (await pauseReason(db, storeId)) === null,
    topicsUnavailable: rows[0]!.failed, writeUnavailable: rows[0]!.write_failed, publishHour: rows[0]!.publish_hour, deliveryMode: rows[0]!.delivery_mode, ...queue }
}

export type ProductRow = {
  id: number
  platformId: string
  title: string
  productType: string
  image: string | null
  facts: number
  usable: boolean
}

export type ProductsState = { sync: SyncProgress; products: ProductRow[] }

/** The Products table: the ones we cannot write about first, so the merchant sees what to fix. */
export async function productsState(db: Db, storeId: number): Promise<ProductsState> {
  const { rows } = await db.query<{ id: number; platform_id: string; title: string; product_type: string; images: { url: string }[]; richness: number | null }>(
    `select id::int, platform_id, title, product_type, images, richness from products
     where store_id = $1 and deleted_at is null
     order by coalesce(richness, 0) >= $2, title`,
    [storeId, CONFIG.minFactsPerProduct],
  )
  return {
    sync: await syncProgress(db, storeId),
    products: rows.map((r) => ({
      id: r.id,
      platformId: r.platform_id,
      title: r.title,
      productType: r.product_type,
      image: r.images[0]?.url ?? null,
      facts: r.richness ?? 0,
      usable: (r.richness ?? 0) >= CONFIG.minFactsPerProduct,
    })),
  }
}

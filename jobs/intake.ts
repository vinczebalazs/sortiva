import type { ShopifyDelivery } from '../connectors/shopify/webhooks.ts'
import { enqueueCatalogChanges } from './catalog.ts'
import type { Deps } from './deps.ts'

/** Records a verified delivery once, by Shopify's delivery id, and schedules the re-read. */
export async function acceptDelivery(deps: Pick<Deps, 'pool' | 'webhookDebounceMs'>, delivery: ShopifyDelivery): Promise<{ duplicate: boolean }> {
  const { rows } = await deps.pool.query<{ id: number }>('select id from stores where shop_domain = $1', [delivery.shopDomain])
  const storeId = rows[0]?.id ?? null
  const inserted = await deps.pool.query(
    `insert into webhook_deliveries (delivery_id, store_id, topic, subject, processed_at)
     values ($1, $2, $3, $4, case when $5 then null else now() end)
     on conflict (delivery_id) do nothing`,
    [delivery.webhookId, storeId, delivery.topic, delivery.subject, storeId !== null && /^(products|collections)\//.test(delivery.topic)],
  )
  if (!inserted.rowCount) return { duplicate: true }
  if (storeId === null) return { duplicate: false }

  if (/^(products|collections)\//.test(delivery.topic)) {
    await enqueueCatalogChanges(deps.pool, storeId, deps.webhookDebounceMs)
  }
  return { duplicate: false }
}

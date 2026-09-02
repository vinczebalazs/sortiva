import type { CatalogEventKind } from './products'

/**
 * What each thing Shopify tells us actually means.
 *
 * Shopify announces changes by topic — `products/update`, `articles/delete` —
 * and the receiver has to decide three things about each one before doing any
 * work: is it about the catalogue, is it about a merchant's relationship with
 * us ending, or is it one of the privacy requests we are obliged to answer.
 *
 * Keeping that decision here, as a table over strings, means the receiver holds
 * no policy and a topic nobody has thought about is refused rather than guessed
 * at.
 */

/** Every topic the app subscribes to. Anything else arriving is not ours. */
export const SHOPIFY_WEBHOOK_TOPICS = [
  'products/create',
  'products/update',
  'products/delete',
  'collections/create',
  'collections/update',
  'inventory_levels/update',
  'articles/create',
  'articles/update',
  'articles/delete',
  'pages/create',
  'pages/update',
  'pages/delete',
  'app/uninstalled',
  'shop/redact',
  'customers/redact',
  'customers/data_request',
] as const

export type ShopifyWebhookTopic = (typeof SHOPIFY_WEBHOOK_TOPICS)[number]

export function isKnownTopic(topic: string): topic is ShopifyWebhookTopic {
  return (SHOPIFY_WEBHOOK_TOPICS as readonly string[]).includes(topic)
}

/**
 * What a topic asks us to do.
 *
 * `catalog` events go into the change stream two other lanes read.
 * `connection_lost` is the uninstall. `privacy` covers the three mandatory
 * requests, which are answered rather than processed.
 */
export type WebhookIntent =
  | { readonly kind: 'catalog'; readonly events: readonly CatalogEventKind[] }
  /**
   * `products/update` is the one topic whose meaning cannot be read off the
   * topic: whether it is a rewrite, a price change or a stock change depends on
   * comparing the product against the one we hold.
   */
  | { readonly kind: 'catalog_product_compare' }
  | { readonly kind: 'connection_lost' }
  | { readonly kind: 'privacy'; readonly request: 'shop_redact' | 'customers_redact' | 'customers_data_request' }

const INTENTS: Readonly<Record<ShopifyWebhookTopic, WebhookIntent>> = {
  'products/create': { kind: 'catalog', events: ['product_created'] },
  'products/update': { kind: 'catalog_product_compare' },
  'products/delete': { kind: 'catalog', events: ['product_deleted'] },
  'collections/create': { kind: 'catalog', events: ['collection_updated'] },
  'collections/update': { kind: 'catalog', events: ['collection_updated'] },
  // Stock moved and nothing else did. Reported so the drift rules can see it;
  // the content inventory deliberately ignores it, because a stock level cannot
  // change a page's words.
  'inventory_levels/update': { kind: 'catalog', events: ['availability_changed'] },
  'articles/create': { kind: 'catalog', events: ['article_updated'] },
  'articles/update': { kind: 'catalog', events: ['article_updated'] },
  'articles/delete': { kind: 'catalog', events: ['article_deleted'] },
  'pages/create': { kind: 'catalog', events: ['page_updated'] },
  'pages/update': { kind: 'catalog', events: ['page_updated'] },
  'pages/delete': { kind: 'catalog', events: ['page_deleted'] },
  'app/uninstalled': { kind: 'connection_lost' },
  'shop/redact': { kind: 'privacy', request: 'shop_redact' },
  'customers/redact': { kind: 'privacy', request: 'customers_redact' },
  'customers/data_request': { kind: 'privacy', request: 'customers_data_request' },
}

export function intentFor(topic: string): WebhookIntent | undefined {
  return isKnownTopic(topic) ? INTENTS[topic] : undefined
}

/**
 * The answer to Shopify's two customer-data requests.
 *
 * It is the same answer every time and it is true by construction: order
 * ingestion strips every customer field at read time, so there is no row to
 * search and nothing to erase. Kept as one constant so the two routes cannot
 * drift apart, and so the sentence we tell Shopify is greppable.
 */
export const NO_CUSTOMER_DATA_HELD = 'no customer data held'

/**
 * Which id inside a webhook body names the thing that changed.
 *
 * Shopify puts the subject's id at the top level of every one of these bodies,
 * except the inventory topics, which name the inventory item rather than the
 * product.
 */
export function subjectIdOf(topic: string, body: Record<string, unknown>): string | undefined {
  const raw =
    topic === 'inventory_levels/update' ? body['inventory_item_id'] : body['id']
  if (raw === null || raw === undefined) return undefined
  const id = String(raw)
  return id.length > 0 ? id : undefined
}

/**
 * When the change happened, as the body reports it.
 *
 * Used to order deliveries against each other, never arrival time: Shopify
 * retries and reorders, so the moment a webhook reached us says nothing about
 * the moment the merchant made the edit.
 */
export function occurredAtOf(body: Record<string, unknown>, fallback: Date): string {
  const stamp = body['updated_at'] ?? body['created_at']
  if (typeof stamp === 'string') {
    const at = new Date(stamp)
    if (!Number.isNaN(at.getTime())) return at.toISOString()
  }
  return fallback.toISOString()
}

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
 * The only fields of a privacy request we write down.
 *
 * An allowlist rather than a list of things to delete, because the two fail in
 * opposite directions: a denylist keeps anything Shopify adds later, and what
 * they add to a message *about a shopper* is likely to be about that shopper.
 * This way a field nobody has considered is dropped, and letting one through is
 * a deliberate edit here.
 *
 * `shop_id` and `shop_domain` name the merchant's store, not a person. The two
 * order-id lists say which orders the request covers, which is what makes the
 * stored row an audit trail — "they asked, on this date, about these orders,
 * and we answered that we hold nothing" — rather than just a timestamp.
 */
const PRIVACY_REQUEST_KEEP = new Set(['shop_id', 'shop_domain', 'orders_to_redact', 'orders_requested'])

/**
 * What may be stored from a webhook, given its topic.
 *
 * Shopify's two customer messages carry the shopper's email and phone in a
 * `customer` object, and their whole point is that we are supposed to hold
 * nothing about that person — so writing the message down verbatim would create
 * the very record we tell Shopify does not exist, in the one row most likely to
 * be produced if anyone ever asks us to prove it.
 *
 * Every topic goes through here, not just the privacy ones, so that a privacy
 * topic added to the intent table later is covered without anyone remembering
 * to come back. Non-privacy topics keep their body unchanged: those are about
 * products and pages, and the drain reads them.
 */
export function storableWebhookBody(
  topic: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (intentFor(topic)?.kind !== 'privacy') return body

  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    // Shape as well as name: an allowed key holding an object would copy
    // whatever that object grows, which is how `customer` got in.
    if (PRIVACY_REQUEST_KEEP.has(key) && isPlainValue(value)) kept[key] = value
  }
  return kept
}

function isPlainValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.every((entry) => entry === null || typeof entry !== 'object')
  return value === null || typeof value !== 'object'
}

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

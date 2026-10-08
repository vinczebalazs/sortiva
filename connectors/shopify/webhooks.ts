import { createHmac, timingSafeEqual } from 'node:crypto'

export type ShopifyDelivery = {
  topic: string
  shopDomain: string
  webhookId: string
  /** The resource's platform id, built from the payload's ids only. */
  subject: string | null
}

const SUBJECT_TYPES: Record<string, string> = { products: 'Product', collections: 'Collection' }

/** Checks the signature over the raw bytes and pulls out only what we act on. Returns null when the signature is wrong. */
export function verifyShopifyWebhook(headers: Record<string, string | undefined>, rawBody: string, clientSecret: string): ShopifyDelivery | null {
  const signature = headers['x-shopify-hmac-sha256']
  if (!signature) return null
  const expected = createHmac('sha256', clientSecret).update(rawBody, 'utf8').digest()
  const given = Buffer.from(signature, 'base64')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null

  const topic = headers['x-shopify-topic'] ?? ''
  const shopDomain = headers['x-shopify-shop-domain'] ?? ''
  const webhookId = headers['x-shopify-webhook-id'] ?? ''
  if (!topic || !shopDomain || !webhookId) return null

  let subject: string | null = null
  const type = SUBJECT_TYPES[topic.split('/')[0]!]
  if (type) {
    const payload = JSON.parse(rawBody) as { id?: number | string; admin_graphql_api_id?: string }
    subject = payload.admin_graphql_api_id ?? (payload.id !== undefined ? `gid://shopify/${type}/${payload.id}` : null)
  }
  return { topic, shopDomain, webhookId, subject }
}

import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { systemScope, unprocessedWebhooks } from '@sortiva/db'
import { databaseAvailable, setupTestDb, type TestDb } from '@sortiva/db/testing'
import { handleShopifyWebhook } from './receiver'

/**
 * The receiver, which does three things and nothing else: prove the message came
 * from Shopify, write it down, answer.
 *
 * Shopify drops a subscription whose owner keeps answering slowly, so the two
 * properties worth pinning are that no decision happens on this path, and that a
 * redelivery costs nothing.
 */

const SECRET = 'shpss_test_secret'
const system = systemScope('the receiver test reads the stored deliveries')

let harness: TestDb

function signed(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://app.example/api/webhooks/shopify/products%2Fupdate', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': createHmac('sha256', SECRET).update(body).digest('base64'),
      'x-shopify-topic': 'products/update',
      'x-shopify-shop-domain': 'acme.myshopify.com',
      'x-shopify-webhook-id': 'delivery-1',
      ...headers,
    },
  })
}

const available = await databaseAvailable()

describe.skipIf(!available)('the Shopify webhook receiver', () => {
  beforeAll(async () => {
    harness = await setupTestDb('shopify_receiver')
  }, 60_000)

  afterAll(async () => {
    await harness?.close()
  })

  beforeEach(async () => {
    await harness.pool.query('truncate webhook_events')
  })

  const options = () => ({ secret: SECRET, database: harness.db, enqueue: false })

  it('accepts a genuine delivery and writes it down', async () => {
    const body = '{"id":700,"title":"Shoe","updated_at":"2026-06-14T10:00:00Z"}'
    const response = await handleShopifyWebhook(signed(body), 'products/update', options())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ received: true })

    const waiting = await unprocessedWebhooks(harness.db, system)
    expect(waiting).toHaveLength(1)
    expect(waiting[0]?.topic).toBe('products/update')
    // The store's name arrives in a header and is kept beside the body, because
    // the drain needs it and the table has no column for it.
    expect((waiting[0]?.payload as Record<string, unknown>)['shop_handle']).toBe('acme')
  })

  it('refuses a forged signature before touching the body', async () => {
    const request = new Request('https://app.example/api/webhooks/shopify/products%2Fupdate', {
      method: 'POST',
      body: '{"id":700}',
      headers: {
        'x-shopify-hmac-sha256': Buffer.from('not the signature').toString('base64'),
        'x-shopify-topic': 'products/update',
        'x-shopify-shop-domain': 'acme.myshopify.com',
        'x-shopify-webhook-id': 'forged-1',
      },
    })

    const response = await handleShopifyWebhook(request, 'products/update', options())
    expect(response.status).toBe(401)
    expect(await unprocessedWebhooks(harness.db, system)).toEqual([])
  })

  it('verifies the exact bytes, so Shopify own spacing still passes', async () => {
    // Shopify's JSON is not what `JSON.stringify` produces. A receiver that
    // parsed and re-serialised before checking would reject every real delivery.
    const body = '{"id":700,  "title":"Shoe"}'
    const response = await handleShopifyWebhook(signed(body), 'products/update', options())
    expect(response.status).toBe(200)
  })

  it('answers a redelivery 200 and writes nothing a second time', async () => {
    const body = '{"id":700,"title":"Shoe"}'
    await handleShopifyWebhook(signed(body), 'products/update', options())
    const second = await handleShopifyWebhook(signed(body), 'products/update', options())

    expect(second.status).toBe(200)
    const { rows } = await harness.pool.query<{ n: string }>(
      'select count(*) as n from webhook_events',
    )
    expect(rows[0]?.n).toBe('1')
  })

  it('refuses a delivery with no id, because a redelivery could not be told apart', async () => {
    const body = '{"id":700}'
    const request = new Request('https://app.example/api/webhooks/shopify/products%2Fupdate', {
      method: 'POST',
      body,
      headers: {
        'x-shopify-hmac-sha256': createHmac('sha256', SECRET).update(body).digest('base64'),
        'x-shopify-topic': 'products/update',
        'x-shopify-shop-domain': 'acme.myshopify.com',
      },
    })

    const response = await handleShopifyWebhook(request, 'products/update', options())
    expect(response.status).toBe(400)
  })

  it('accepts and drops a topic we never subscribed to', async () => {
    const body = '{"id":1}'
    const request = new Request('https://app.example/api/webhooks/shopify/orders%2Fcreate', {
      method: 'POST',
      body,
      headers: {
        'x-shopify-hmac-sha256': createHmac('sha256', SECRET).update(body).digest('base64'),
        'x-shopify-topic': 'orders/create',
        'x-shopify-shop-domain': 'acme.myshopify.com',
        'x-shopify-webhook-id': 'unknown-1',
      },
    })

    const response = await handleShopifyWebhook(request, 'orders/create', options())
    // 200 so Shopify stops retrying, but nothing is stored.
    expect(response.status).toBe(200)
    expect(await unprocessedWebhooks(harness.db, system)).toEqual([])
  })

  it('refuses everything when no secret is configured', async () => {
    const response = await handleShopifyWebhook(signed('{"id":1}'), 'products/update', {
      secret: '',
      database: harness.db,
      enqueue: false,
    })
    // The safe direction: with no secret every signature would verify.
    expect(response.status).toBe(500)
  })

  it('does not decide anything: the delivery is still waiting when the answer goes back', async () => {
    const body = '{"id":700,"title":"Shoe"}'
    await handleShopifyWebhook(signed(body), 'products/update', options())

    // Nothing was written to the catalogue by the request itself — the whole
    // point of answering first and working afterwards.
    const { rows } = await harness.pool.query<{ n: string }>('select count(*) as n from products')
    expect(rows[0]?.n).toBe('0')
    expect(await unprocessedWebhooks(harness.db, system)).toHaveLength(1)
  })
})

describe('database availability (receiver suite)', () => {
  it('reports whether the receiver tests actually ran', () => {
    if (!available) {
      throw new Error(
        'No Postgres at the test URL. The receiver tests cannot be skipped silently — ' +
          'run `pnpm db:up` first.',
      )
    }
    expect(available).toBe(true)
  })
})

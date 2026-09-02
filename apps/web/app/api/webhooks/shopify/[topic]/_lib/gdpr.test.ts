import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { NO_CUSTOMER_DATA_HELD, type Logger } from '@sortiva/core'
import { databaseAvailable, setupTestDb, type TestDb } from '@sortiva/db/testing'
import { drainShopifyWebhooks } from '@sortiva/jobs/ingestion/webhooks'
import { handleShopifyWebhook } from './receiver'

/**
 * Shopify's two customer-privacy messages, end to end: the merchant's shopper
 * asked what we hold about them, and asked us to erase it.
 *
 * Our answer to both is that we hold nothing about their shoppers, and it is
 * meant to be true by construction rather than by policy — order ingestion
 * strips every customer field at read time, so there is no row to search and
 * nothing to erase. Two tests in `packages/db` prove the construction: no column
 * could carry a shopper's identity, and no table is about shoppers at all. This
 * proves the answer itself is given — a 200, and the sentence recorded.
 *
 * The 200 matters as much as the sentence: Shopify retries a slow answer and
 * eventually drops the app's listing, and these are the messages an app-store
 * listing is checked against.
 */

const SECRET = 'shpss_test_secret'
const PRIVACY_TOPICS = ['customers/data_request', 'customers/redact'] as const

let harness: TestDb

function signed(topic: string, body: string, webhookId: string): Request {
  return new Request(
    `https://app.example/api/webhooks/shopify/${encodeURIComponent(topic)}`,
    {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': createHmac('sha256', SECRET).update(body).digest('base64'),
        'x-shopify-topic': topic,
        'x-shopify-shop-domain': 'acme.myshopify.com',
        'x-shopify-webhook-id': webhookId,
      },
    },
  )
}

function recordingLogger(into: { msg: string; fields: Record<string, unknown> }[]): Logger {
  const log: Logger = {
    debug: () => {},
    info: (msg, fields) => into.push({ msg, fields: fields ?? {} }),
    warn: () => {},
    error: () => {},
    child: () => log,
  }
  return log
}

const available = await databaseAvailable()

describe.skipIf(!available)('Shopify’s customer-privacy webhooks', () => {
  beforeAll(async () => {
    harness = await setupTestDb('shopify_gdpr')
  }, 60_000)

  afterAll(async () => {
    await harness?.close()
  })

  beforeEach(async () => {
    await harness.pool.query('truncate webhook_events')
  })

  const options = () => ({ secret: SECRET, getDatabase: () => harness.db, enqueue: false })

  it.each(PRIVACY_TOPICS)('answers %s with a 200', async (topic) => {
    const response = await handleShopifyWebhook(
      signed(topic, '{"shop_id":1,"shop_domain":"acme.myshopify.com"}', `d-${topic}`),
      topic,
      options(),
    )
    expect(response.status).toBe(200)
  })

  it.each(PRIVACY_TOPICS)('records "no customer data held" for %s', async (topic) => {
    await handleShopifyWebhook(
      signed(topic, '{"shop_id":1,"shop_domain":"acme.myshopify.com"}', `d2-${topic}`),
      topic,
      options(),
    )

    const lines: { msg: string; fields: Record<string, unknown> }[] = []
    const result = await drainShopifyWebhooks({
      ingestion: () => ({ db: harness.db, pool: harness.pool }) as never,
      logger: recordingLogger(lines),
    })

    expect(result.processed).toBe(1)
    const answered = lines.find((line) => line.msg === 'shopify_privacy_request')
    expect(answered, 'the privacy request was not answered anywhere').toBeDefined()
    expect(answered!.fields['topic']).toBe(topic)
    expect(answered!.fields['answer']).toBe(NO_CUSTOMER_DATA_HELD)
  })

  it('says it in the words the constant fixes, so the two routes cannot drift', () => {
    expect(NO_CUSTOMER_DATA_HELD).toBe('no customer data held')
  })

  it('needs no account, and asks for none', async () => {
    // The answer is the same for every store because it is a fact about our
    // schema, not about theirs. A lookup here would be a lookup that could fail.
    await handleShopifyWebhook(
      signed('customers/redact', '{"shop_id":1}', 'd-unknown-store'),
      'customers/redact',
      options(),
    )
    const lines: { msg: string; fields: Record<string, unknown> }[] = []
    const result = await drainShopifyWebhooks({
      ingestion: () => ({ db: harness.db, pool: harness.pool }) as never,
      logger: recordingLogger(lines),
    })
    // Not "ignored", which is what an unknown store gets for every other topic.
    expect(result.processed).toBe(1)
  })
})

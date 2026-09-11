import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { silentLogger, type DomainState } from '@sortiva/core'
import { readCatalogChanges, systemScope } from '@sortiva/db'
import {
  TEST_DATABASE_URL,
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import type { IngestionDeps } from '@sortiva/jobs/ingestion/deps'
import { drainShopifyWebhooks } from '@sortiva/jobs/ingestion/webhooks'
import { DatabaseCatalogEvents } from '@sortiva/jobs/ingestion/stream'
import { drainCatalogEvents } from '@sortiva/jobs/inventory/drain'
import {
  INVENTORY_CATALOG_EVENTS_TASK,
  INVENTORY_SYNC_TASK,
} from '@sortiva/jobs/inventory/queue'
import {
  TRUNCATE_QUEUE_SQL,
  installQueueSchema,
  type WorkerUtils,
} from '@sortiva/jobs/runtime/testing'
import { handleShopifyWebhook } from './receiver'

/**
 * A merchant's edit actually reaching the product.
 *
 * Recording what a merchant changed has worked for a while; nothing read it.
 * The change went into the shared change record and stayed there until the
 * nightly walk found it, so a product description rewritten at nine in the
 * morning was still being recommended against at five in the afternoon. What is
 * proved here is the join: a delivery that arrives at the receiver leaves a
 * waiting pass behind it, that pass re-reads exactly the pages the merchant
 * touched, a delivery that changed nothing leaves nothing waiting, and a burst
 * of edits leaves one pass rather than one each.
 *
 * Everything is asserted against the queue's own tables. A test that watched a
 * stand-in being called would prove the call and not the effect, and the effect
 * — one job, not forty — is the whole point.
 */

const SECRET = 'shpss_test_secret'

let harness: TestDb
let pool: TestDb['pool']
let utils: WorkerUtils
let accountId: string

const system = systemScope('the wiring test reads the change record across accounts')

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

/** A delivery, through the receiver: signed, verified, written down, answered. */
async function deliver(topic: string, body: Record<string, unknown>, webhookId: string) {
  const response = await handleShopifyWebhook(signed(topic, JSON.stringify(body), webhookId), topic, {
    secret: SECRET,
    getDatabase: () => harness.db,
  })
  expect(response.status, `the receiver refused ${topic}`).toBe(200)
}

/**
 * What the handler reaches outside itself. Only the store lookup is real work
 * here: turning a delivery into a recorded change fetches no page and makes no
 * call back to Shopify, and these throw rather than return so a change of that
 * would be loud.
 */
function ingestion(): IngestionDeps {
  return {
    db: harness.db,
    pool,
    fetcher: { async fetch() { throw new Error('no page is fetched while recording a change') } },
    shopify: {
      authorizeUrl: () => '',
      verifyCallbackSignature: () => true,
      exchangeCode: async () => { throw new Error('no token is traded while recording a change') },
      refreshAccess: async () => { throw new Error('no token is renewed while recording a change') },
      revokeAccess: async () => {},
    },
    shop: { async getShop() { throw new Error('no Shopify call is made while recording a change') } },
    connections: {
      async read() { return undefined },
      async authFor() { return undefined },
      async markInvalid(_accountId: string, at: Date) { return at },
    },
    domains: {
      async findAccountByShopHandle() { return accountId },
      async setPlatform() {},
      async transition(_id: string, _from: DomainState, to: DomainState) { return to },
      async read() { return 'ingesting' },
      async readNormalized() { return 'acme.example' },
    },
  } as unknown as IngestionDeps
}

async function drainDeliveries() {
  return drainShopifyWebhooks({ ingestion, logger: silentLogger })
}

interface QueuedJob {
  readonly payload: { accountId?: string; targets?: readonly { kind: string; shopifyId: string }[] }
  readonly key: string | null
}

async function queued(task: string): Promise<QueuedJob[]> {
  const { rows } = await pool.query<QueuedJob>(
    `select j.payload, j.key
       from graphile_worker._private_jobs as j
       join graphile_worker._private_tasks as t on t.id = j.task_id
      where t.identifier = $1
      order by j.id`,
    [task],
  )
  return rows
}

const product = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  title: `Ridgeline Trail Shoe ${id}`,
  body_html: '<p>A trail shoe.</p>',
  handle: `ridgeline-${id}`,
  product_type: 'Shoes',
  tags: 'trail',
  status: 'active',
  updated_at: '2026-06-14T10:00:00Z',
  variants: [{ id: id * 10, title: 'UK 8', sku: `RTS-${id}`, price: '120.00', inventory_quantity: 3 }],
  ...overrides,
})

const available = await databaseAvailable()

describe.skipIf(!available)('a merchant’s edit reaching the product', () => {
  beforeAll(async () => {
    harness = await setupTestDb('shopify_stream_wire')
    pool = harness.pool
    // The queue's own tables are installed by the worker rather than by our
    // migrations, and every assertion below reads them.
    const url = new URL(TEST_DATABASE_URL)
    url.pathname = `/${harness.databaseName}`
    utils = await installQueueSchema(url.toString())
  }, 60_000)

  afterAll(async () => {
    await utils?.release()
    await harness?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    await pool.query('truncate webhook_events')
    await pool.query(TRUNCATE_QUEUE_SQL)
    accountId = await insertAccount(pool, `wire-${Date.now()}@example.com`)
    await pool.query(
      `insert into domains (account_id, domain_normalized, platform, state)
       values ($1, 'acme.example', 'shopify', 'ingesting')`,
      [accountId],
    )
  })

  it('leaves a pass waiting behind a single edit', async () => {
    await deliver('products/update', product(700), 'd-one')
    const result = await drainDeliveries()
    expect(result).toMatchObject({ processed: 1, failed: 0 })

    const passes = await queued(INVENTORY_CATALOG_EVENTS_TASK)
    expect(passes, 'the edit was recorded and nothing was asked to read it').toHaveLength(1)
    expect(passes[0]?.payload.accountId).toBe(accountId)
  })

  it('asks for a re-read of exactly the pages that changed, and no others', async () => {
    await deliver('products/update', product(700), 'd-product')
    await deliver('collections/update', { id: 901, updated_at: '2026-06-14T10:05:00Z' }, 'd-collection')
    // The last one in stock sold and nothing else moved. Recorded for the drift
    // rules, and deliberately not a reason to read the page again: a stock level
    // cannot change a page's words.
    await deliver(
      'products/update',
      product(700, {
        updated_at: '2026-06-14T10:06:00Z',
        variants: [{ id: 7000, title: 'UK 8', sku: 'RTS-700', price: '120.00', inventory_quantity: 0 }],
      }),
      'd-stock',
    )
    await drainDeliveries()

    const stream = await readCatalogChanges(harness.db, system, accountId, undefined)
    expect(stream.changes.map((change) => change.kind).sort()).toEqual([
      'availability_changed',
      'collection_updated',
      'product_created',
    ])

    const pass = await drainCatalogEvents(
      {
        getDb: () => harness.db,
        catalogEvents: new DatabaseCatalogEvents(() => harness.db),
        logger: silentLogger,
      },
      { accountId },
    )

    expect(pass.events).toBe(3)
    expect(pass.requested).toBe(2)

    const rereads = await queued(INVENTORY_SYNC_TASK)
    expect(rereads).toHaveLength(1)
    expect([...(rereads[0]?.payload.targets ?? [])].sort(byId)).toEqual([
      { kind: 'product', shopifyId: '700' },
      { kind: 'collection', shopifyId: '901' },
    ])
  })

  it('asks for nothing when a delivery turns out to have changed nothing', async () => {
    await deliver('products/update', product(700), 'd-first')
    await drainDeliveries()
    expect(await queued(INVENTORY_CATALOG_EVENTS_TASK)).toHaveLength(1)

    // Shopify announces a product whose words, prices and stock are all exactly
    // what we already hold — an edit to a field we do not track, or a touch.
    // Newer than ours, so it is not discarded as stale; identical, so there is
    // nothing to record and nothing to read.
    await pool.query(TRUNCATE_QUEUE_SQL)
    await deliver(
      'products/update',
      product(700, { updated_at: '2026-06-14T18:00:00Z' }),
      'd-second',
    )
    const result = await drainDeliveries()

    expect(result).toMatchObject({ processed: 1, failed: 0 })
    const stream = await readCatalogChanges(harness.db, system, accountId, undefined)
    expect(stream.changes, 'a second, identical description recorded a change').toHaveLength(1)
    expect(await queued(INVENTORY_CATALOG_EVENTS_TASK)).toEqual([])
  })

  /**
   * The property this is here to hold: a merchant re-tagging forty products in
   * one afternoon must cost one pass over their change record, not forty.
   *
   * It holds because the ask carries a job key naming the account and nothing
   * else, so a second ask while one is still waiting replaces it. Nothing in the
   * handler counts or debounces — the queue is the mechanism, which is why this
   * asserts against the queue. Take the key off and this goes red.
   */
  it('leaves one pass behind a burst of edits, not one per edit', async () => {
    const ids = [701, 702, 703, 704, 705]
    for (const id of ids) {
      await deliver('products/update', product(id), `d-burst-${id}`)
    }
    const result = await drainDeliveries()
    expect(result).toMatchObject({ seen: 5, processed: 5, failed: 0 })

    // Not vacuous: five separate changes really were recorded, so five separate
    // asks really were made.
    const stream = await readCatalogChanges(harness.db, system, accountId, undefined)
    expect(stream.changes).toHaveLength(5)

    const passes = await queued(INVENTORY_CATALOG_EVENTS_TASK)
    expect(passes).toHaveLength(1)
    expect(passes[0]?.key).toBe(`${INVENTORY_CATALOG_EVENTS_TASK}:${accountId}`)
  })
})

describe('database availability (change-stream wiring suite)', () => {
  it('reports whether the wiring tests actually ran', () => {
    if (!available) {
      throw new Error(
        'No Postgres at the test URL. The change-stream wiring tests cannot be skipped ' +
          'silently — run `pnpm db:up` first.',
      )
    }
    expect(available).toBe(true)
  })
})

function byId(a: { shopifyId: string }, b: { shopifyId: string }): number {
  return a.shopifyId.localeCompare(b.shopifyId)
}

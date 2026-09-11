import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type {
  DomainState,
  ShopifyAuth,
  ShopifyOAuthProvider,
  StoreConnection,
} from '@sortiva/core'
import { StubNotificationEmitter, silentLogger, staticShopifyAuth } from '@sortiva/core'
import {
  MAX_WEBHOOK_ATTEMPTS,
  readCatalogChanges,
  recordWebhookEvent,
  systemScope,
  unprocessedWebhooks,
} from '@sortiva/db'
import {
  TEST_DATABASE_URL,
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import {
  TRUNCATE_QUEUE_SQL,
  installQueueSchema,
  type WorkerUtils,
} from '../runtime/testing'
import { verifyWebhookHmac } from '@sortiva/providers'
import type { ConnectionStore, IngestionDeps } from './deps'
import { drainShopifyWebhooks } from './webhooks'
import { DatabaseCatalogEvents } from './stream'

/**
 * What Shopify tells us, and what we do about it.
 *
 * Two properties the card turns on are proved here. A duplicate delivery is a
 * no-op — the second copy writes nothing and changes nothing. And an edit that
 * arrives after a newer one is ignored rather than applied, because Shopify
 * reorders deliveries as a matter of course and applying the older one would
 * leave our copy disagreeing with the merchant's own admin until the nightly
 * sweep repaired it.
 */

let harness: TestDb
let queue: WorkerUtils
let accountId: string
const system = systemScope('the webhook tests read across accounts')

/**
 * The install handshake, which none of these tests goes through: the store is
 * already connected before anything here starts.
 */
const alreadyInstalled: ShopifyOAuthProvider = {
  authorizeUrl: () => '',
  verifyCallbackSignature: () => true,
  exchangeCode: async () => {
    throw new Error('these tests never install the app')
  },
  refreshAccess: async () => {
    throw new Error('these tests never renew a token')
  },
  revokeAccess: async () => {},
}

class FakeConnections implements ConnectionStore {
  connection: StoreConnection | undefined

  constructor(accountIdValue: string) {
    this.connection = {
      accountId: accountIdValue,
      shopHandle: 'acme',
      grantedScopes: ['read_products'],
      connectedAt: new Date('2026-09-01T09:00:00Z'),
      invalidatedAt: null,
    }
  }

  async read(): Promise<StoreConnection | undefined> {
    return this.connection
  }

  async authFor(): Promise<ShopifyAuth | undefined> {
    return staticShopifyAuth('acme', 'shpat_test')
  }

  async markInvalid(_accountId: string, at: Date): Promise<Date> {
    if (this.connection && this.connection.invalidatedAt === null) {
      this.connection = { ...this.connection, invalidatedAt: at }
    }
    return this.connection?.invalidatedAt ?? at
  }
}

interface World {
  deps: IngestionDeps
  connections: FakeConnections
  notifications: StubNotificationEmitter
  transitions: DomainState[]
}

function world(): World {
  const connections = new FakeConnections(accountId)
  const notifications = new StubNotificationEmitter()
  const transitions: DomainState[] = []

  const deps: IngestionDeps = {
    db: harness.db,
    pool: harness.pool,
    fetcher: { async fetch() { throw new Error('webhook handling makes no page fetches') } },
    shopify: alreadyInstalled,
    shop: { async getShop() { throw new Error('not used') } },
    connections,
    notifications,
    domains: {
      async findAccountByShopHandle() { return accountId },
      async setPlatform() {},
      async transition(_id, _from, to) {
        transitions.push(to)
        return to
      },
      async read() { return 'ingesting' },
      async readNormalized() { return 'acme.example' },
    },
  }
  return { deps, connections, notifications, transitions }
}

/** Writes a delivery down the way the receiver does. */
async function deliver(input: {
  webhookId: string
  topic: string
  body: Record<string, unknown>
  shopHandle?: string
}) {
  return recordWebhookEvent(harness.db, system, {
    webhookId: input.webhookId,
    source: 'shopify',
    topic: input.topic,
    payload: { shop_handle: input.shopHandle ?? 'acme', body: input.body },
  })
}

const available = await databaseAvailable()

describe.skipIf(!available)('acting on what Shopify told us', () => {
  beforeAll(async () => {
    harness = await setupTestDb('shopify_webhooks')
    // Recording a change now also asks for it to be read, and the ask goes on
    // the queue — whose tables the worker installs, not our migrations.
    const url = new URL(TEST_DATABASE_URL)
    url.pathname = `/${harness.databaseName}`
    queue = await installQueueSchema(url.toString())
  }, 60_000)

  afterAll(async () => {
    await queue?.release()
    await harness?.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    await harness.pool.query('truncate webhook_events')
    await harness.pool.query(TRUNCATE_QUEUE_SQL)
    accountId = await insertAccount(harness.pool, `hook-${Date.now()}@example.com`)
    await harness.pool.query(
      `insert into domains (account_id, domain_normalized, platform, state)
       values ($1, 'acme.example', 'shopify', 'ingesting')`,
      [accountId],
    )
  })

  const productBody = (overrides: Record<string, unknown> = {}) => ({
    id: 700,
    title: 'Ridgeline Trail Shoe',
    body_html: '<p>A trail shoe.</p>',
    handle: 'ridgeline',
    product_type: 'Shoes',
    tags: 'trail',
    status: 'active',
    updated_at: '2026-06-14T10:00:00Z',
    variants: [{ id: 1, title: 'UK 8', sku: 'RTS-8', price: '120.00', inventory_quantity: 3 }],
    ...overrides,
  })

  it('records the change a product edit amounts to', async () => {
    await deliver({ webhookId: 'w1', topic: 'products/update', body: productBody() })
    const result = await drainShopifyWebhooks({ ingestion: () => world().deps })

    expect(result).toMatchObject({ seen: 1, processed: 1, ignored: 0, failed: 0 })
    const stream = await readCatalogChanges(harness.db, system, accountId, undefined)
    expect(stream.changes.map((c) => [c.kind, c.entityId])).toEqual([['product_created', '700']])
  })

  it("keeps the store's option axes from a delivery, and does not clear its metafields", async () => {
    // A delivery carries the product's options and never its metafields, which
    // cost a request of their own. Writing "no metafields" from here would lose
    // what the catalogue sync went and fetched, every time a merchant edited a
    // price.
    await deliver({ webhookId: 'w1', topic: 'products/update', body: productBody() })
    await drainShopifyWebhooks({ ingestion: () => world().deps })
    await harness.pool.query(
      `update products set metafields = '[{"namespace":"custom","key":"terrain","value":"Trail","type":"single_line_text_field"}]'::jsonb`,
    )

    await deliver({
      webhookId: 'w2',
      topic: 'products/update',
      body: productBody({
        options: [{ name: 'Size', values: ['UK 8', 'UK 9'] }],
        updated_at: '2026-06-15T10:00:00Z',
      }),
    })
    await drainShopifyWebhooks({ ingestion: () => world().deps })

    const { rows } = await harness.pool.query<{ options: unknown; metafields: unknown }>(
      'select options, metafields from products',
    )
    expect(rows[0]?.options).toEqual([{ name: 'Size', values: ['UK 8', 'UK 9'] }])
    expect(rows[0]?.metafields).toEqual([
      { namespace: 'custom', key: 'terrain', value: 'Trail', type: 'single_line_text_field' },
    ])
  })

  it('treats a duplicate delivery as a no-op', async () => {
    const body = productBody()
    expect(await deliver({ webhookId: 'w1', topic: 'products/update', body })).toBeDefined()
    // Shopify redelivering the same message: the same webhook id.
    expect(await deliver({ webhookId: 'w1', topic: 'products/update', body })).toBeUndefined()

    const { rows } = await harness.pool.query<{ n: string }>(
      'select count(*) as n from webhook_events',
    )
    expect(rows[0]?.n).toBe('1')

    const first = await drainShopifyWebhooks({ ingestion: () => world().deps })
    expect(first.processed).toBe(1)

    // Draining again finds nothing left to do, and nothing new is written.
    const second = await drainShopifyWebhooks({ ingestion: () => world().deps })
    expect(second).toMatchObject({ seen: 0, processed: 0 })

    const stream = await readCatalogChanges(harness.db, system, accountId, undefined)
    expect(stream.changes).toHaveLength(1)
    const { rows: products } = await harness.pool.query<{ n: string }>(
      'select count(*) as n from products',
    )
    expect(products[0]?.n).toBe('1')
  })

  it('ignores an edit older than the one it already holds', async () => {
    await deliver({
      webhookId: 'w-new',
      topic: 'products/update',
      body: productBody({ updated_at: '2026-06-14T12:00:00Z', title: 'The current title' }),
    })
    await drainShopifyWebhooks({ ingestion: () => world().deps })
    const afterFirst = await readCatalogChanges(harness.db, system, accountId, undefined)

    // Shopify redelivering an earlier edit after a later one. Applying it would
    // put yesterday's title back.
    await deliver({
      webhookId: 'w-old',
      topic: 'products/update',
      body: productBody({ updated_at: '2026-06-14T09:00:00Z', title: 'The stale title' }),
    })
    const result = await drainShopifyWebhooks({ ingestion: () => world().deps })

    expect(result).toMatchObject({ processed: 0, ignored: 1 })
    const { rows } = await harness.pool.query<{ title: string }>('select title from products')
    expect(rows[0]?.title).toBe('The current title')
    const stream = await readCatalogChanges(harness.db, system, accountId, afterFirst.cursor)
    expect(stream.changes).toEqual([])
  })

  it('records a collection being created and edited', async () => {
    await deliver({ webhookId: 'c1', topic: 'collections/create', body: { id: 800, updated_at: '2026-06-14T10:00:00Z' } })
    await deliver({ webhookId: 'c2', topic: 'collections/update', body: { id: 800, updated_at: '2026-06-14T11:00:00Z' } })
    await drainShopifyWebhooks({ ingestion: () => world().deps })

    const stream = await readCatalogChanges(harness.db, system, accountId, undefined)
    expect(stream.changes.map((c) => [c.kind, c.entityId])).toEqual([
      ['collection_updated', '800'],
      ['collection_updated', '800'],
    ])
  })

  it('passes over a delivery on a topic we never subscribed to', async () => {
    // Shopify publishes no topic at all for a blog post or a static page being
    // edited, and the topic for stock levels needs a permission over a
    // merchant's warehouse that a writer of articles has no business asking
    // for. An edit to either reaches us on the nightly re-read instead — that
    // gap is real, and subscribing to topics that do not exist would only have
    // hidden it.
    await deliver({ webhookId: 'a1', topic: 'articles/update', body: { id: 900, updated_at: '2026-06-14T10:00:00Z' } })
    await deliver({ webhookId: 'p1', topic: 'pages/delete', body: { id: 901 } })
    await deliver({
      webhookId: 'i1',
      topic: 'inventory_levels/update',
      body: { inventory_item_id: 42, available: 0, updated_at: '2026-06-14T10:00:00Z' },
    })

    const result = await drainShopifyWebhooks({ ingestion: () => world().deps })

    expect(result).toMatchObject({ seen: 3, processed: 0, ignored: 3, failed: 0 })
    const stream = await readCatalogChanges(harness.db, system, accountId, undefined)
    expect(stream.changes).toEqual([])
    // Settled rather than left to be drained for ever.
    expect(await unprocessedWebhooks(harness.db, system)).toEqual([])
  })

  it('notices a product going out of stock, which arrives as an edit to the product', async () => {
    await deliver({ webhookId: 'w1', topic: 'products/update', body: productBody() })
    await drainShopifyWebhooks({ ingestion: () => world().deps })
    const afterFirst = await readCatalogChanges(harness.db, system, accountId, undefined)

    // The last one sold. Shopify says so through the product, not through a
    // warehouse topic.
    await deliver({
      webhookId: 'w2',
      topic: 'products/update',
      body: productBody({
        updated_at: '2026-06-15T10:00:00Z',
        variants: [{ id: 1, title: 'UK 8', sku: 'RTS-8', price: '120.00', available: false }],
      }),
    })
    await drainShopifyWebhooks({ ingestion: () => world().deps })

    const stream = await readCatalogChanges(harness.db, system, accountId, afterFirst.cursor)
    expect(stream.changes.map((c) => [c.kind, c.entityId])).toEqual([
      ['availability_changed', '700'],
    ])
  })

  it('tries a delivery it could not act on again, and gives up on it in the end', async () => {
    // The commonest reason to be here is the store being busy with its own
    // nightly sync, which is over in minutes. Stamping such a delivery as done
    // meant a merchant's edit waited for the next night's re-read.
    const state = world()
    state.deps.domains.findAccountByShopHandle = async () => {
      throw new Error('the store was busy with other work')
    }
    await deliver({ webhookId: 'w1', topic: 'products/update', body: productBody() })

    for (let attempt = 1; attempt < MAX_WEBHOOK_ATTEMPTS; attempt += 1) {
      const result = await drainShopifyWebhooks({
        ingestion: () => state.deps,
        logger: silentLogger,
      })
      expect(result).toMatchObject({ seen: 1, processed: 0, failed: 1 })
      // Still there, still unfinished: the next pass picks it up again.
      const waiting = await unprocessedWebhooks(harness.db, system)
      expect(waiting.map((row) => [row.webhookId, row.attempts])).toEqual([['w1', attempt]])
    }

    const lastTry = await drainShopifyWebhooks({
      ingestion: () => state.deps,
      logger: silentLogger,
    })
    expect(lastTry).toMatchObject({ seen: 1, failed: 1 })

    // A delivery nobody can process must not be re-read on every drain for the
    // thirty days before it is pruned.
    expect(await unprocessedWebhooks(harness.db, system)).toEqual([])
    const { rows } = await harness.pool.query<{ attempts: number; status: string }>(
      'select attempts, status from webhook_events where webhook_id = $1',
      ['w1'],
    )
    expect(rows[0]).toMatchObject({ attempts: MAX_WEBHOOK_ATTEMPTS, status: 'failed' })
  })

  it('answers the two customer-data requests without looking anything up', async () => {
    await deliver({ webhookId: 'g1', topic: 'customers/redact', body: { shop_id: 1 } })
    await deliver({ webhookId: 'g2', topic: 'customers/data_request', body: { shop_id: 1 } })

    const result = await drainShopifyWebhooks({ ingestion: () => world().deps })
    expect(result).toMatchObject({ processed: 2, failed: 0 })
    // Nothing was searched for and nothing was erased, because there is nothing
    // to search: no customer field reaches storage in the first place.
    const stream = await readCatalogChanges(harness.db, system, accountId, undefined)
    expect(stream.changes).toEqual([])
  })

  it('moves a store to the reconnect screen when the app is uninstalled', async () => {
    const state = world()
    await deliver({ webhookId: 'u1', topic: 'app/uninstalled', body: { id: 1 } })

    const result = await drainShopifyWebhooks({ ingestion: () => state.deps })
    expect(result.processed).toBe(1)
    expect(state.connections.connection?.invalidatedAt).not.toBeNull()
    expect(state.transitions).toContain('awaiting_shopify_auth')
    expect(state.notifications.emitted.map((e) => e.type)).toContain('connection_lost_shopify')
  })

  it('ignores a delivery about a store nobody here holds', async () => {
    const state = world()
    state.deps.domains.findAccountByShopHandle = async () => undefined
    await deliver({ webhookId: 'x1', topic: 'products/update', body: productBody(), shopHandle: 'stranger' })

    const result = await drainShopifyWebhooks({ ingestion: () => state.deps })
    expect(result).toMatchObject({ processed: 0, ignored: 1 })
    expect(await unprocessedWebhooks(harness.db, system)).toEqual([])
  })

  it('hands the changes to a consumer through the frozen stream contract', async () => {
    await deliver({ webhookId: 'w1', topic: 'products/update', body: productBody() })
    await deliver({ webhookId: 'c1', topic: 'collections/update', body: { id: 800, updated_at: '2026-06-14T11:00:00Z' } })
    await drainShopifyWebhooks({ ingestion: () => world().deps })

    const stream = new DatabaseCatalogEvents(() => harness.db)
    const first = await stream.since(accountId)
    expect(first.events.map((e) => e.kind)).toEqual(['product_created', 'collection_updated'])

    // A consumer that hands its place back gets nothing twice.
    const second = await stream.since(accountId, first.cursor)
    expect(second.events).toEqual([])
  })
})

describe('the signature check the receiver depends on', () => {
  it('verifies the exact bytes received, not a re-serialisation', () => {
    const secret = 'shpss_test'
    // Shopify's own spacing. Parsing and re-stringifying this produces
    // different bytes and would fail its own signature.
    const raw = Buffer.from('{"id":700,  "title":"Shoe"}', 'utf8')
    const signature = createHmac('sha256', secret).update(raw).digest('base64')

    expect(verifyWebhookHmac(raw, signature, secret)).toBe(true)
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8'))), 'utf8')
    expect(verifyWebhookHmac(reserialised, signature, secret)).toBe(false)
  })
})

describe('database availability (webhook suite)', () => {
  it('reports whether the webhook tests actually ran', () => {
    if (!available) {
      throw new Error(
        'No Postgres at the test URL. The webhook tests cannot be skipped silently — ' +
          'run `pnpm db:up` first.',
      )
    }
    expect(available).toBe(true)
  })
})

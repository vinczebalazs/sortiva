import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { StoreConnection } from '@sortiva/core'
import { listLandingRevenue, readCatalogChanges, systemScope, accountScope } from '@sortiva/db'
import {
  TEST_DATABASE_URL,
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { TRUNCATE_QUEUE_SQL, installQueueSchema, type WorkerUtils } from '../runtime/testing'
import type { ConnectionStore, IngestionDeps, ShopifyListReader } from './deps'
import { aggregateLandingRevenue, reconcileStoreCatalog, runReconciliationSweep } from './sweep'

/**
 * The nightly re-read, which exists because webhooks drop silently.
 *
 * The property the card turns on is convergence: run the sweep twice over an
 * unchanged store and the second pass must find nothing, record nothing, and
 * leave the same rows behind. Anything else means a store that never changes
 * accumulates change records for ever, and every consumer downstream re-reads
 * pages that did not move.
 */

let harness: TestDb
let accountId: string
/**
 * The queue's own tables are created by the worker at start-up rather than by
 * our migrations, and the sweep queues a job per store — so this suite installs
 * them itself, the way `T-START` established.
 */
let queue: WorkerUtils | undefined
const system = systemScope('the sweep tests read the change stream')

class FakeShopify implements ShopifyListReader {
  readonly requested: string[] = []

  constructor(
    public products: Record<string, unknown>[],
    public orders: Record<string, unknown>[] = [],
    private readonly pageSize = 100,
  ) {}

  /** Metafields keyed by Shopify product id, as a store that publishes them would answer. */
  metafields: Record<string, Record<string, unknown>[]> = {}

  async getPage<T>(
    _auth: { shop: string; accessToken: string },
    path: string,
  ): Promise<{ body: T; nextPageInfo: string | undefined }> {
    this.requested.push(path)
    const metafieldsFor = /^products\/(\d+)\/metafields\.json/.exec(path)
    if (metafieldsFor) {
      return {
        body: { metafields: this.metafields[metafieldsFor[1]!] ?? [] } as T,
        nextPageInfo: undefined,
      }
    }
    const isOrders = path.startsWith('orders.json')
    const list = isOrders ? this.orders : this.products
    const key = isOrders ? 'orders' : 'products'
    const offset = Number(new URLSearchParams(path.split('?')[1] ?? '').get('page_info') ?? '0')
    const slice = list.slice(offset, offset + this.pageSize)
    const next = offset + this.pageSize < list.length ? String(offset + this.pageSize) : undefined
    return { body: { [key]: slice } as T, nextPageInfo: next }
  }
}

class FakeConnections implements ConnectionStore {
  connection: StoreConnection | undefined

  constructor(accountIdValue: string) {
    this.connection = {
      accountId: accountIdValue,
      shopHandle: 'acme',
      grantedScopes: ['read_products', 'read_orders'],
      connectedAt: new Date('2026-09-01T09:00:00Z'),
      invalidatedAt: null,
    }
  }

  async read(): Promise<StoreConnection | undefined> {
    return this.connection
  }

  async readToken(): Promise<string | undefined> {
    return this.connection && this.connection.invalidatedAt === null ? 'shpat_test' : undefined
  }

  async markInvalid(_accountId: string, at: Date): Promise<Date> {
    if (this.connection) this.connection = { ...this.connection, invalidatedAt: at }
    return at
  }
}

function deps(
  admin: ShopifyListReader,
  connections = new FakeConnections(accountId),
  today = '2026-06-20T03:00:00Z',
) {
  const ingestion: IngestionDeps = {
    db: harness.db,
    pool: harness.pool,
    fetcher: { async fetch() { throw new Error('the sweep makes no page fetches') } },
    shopify: {
      authorizeUrl: () => '',
      verifyCallbackSignature: () => true,
      exchangeCode: async () => ({ accessToken: '', grantedScopes: [] }),
      revokeAccess: async () => {},
    },
    shop: { async getShop() { throw new Error('not used') } },
    admin,
    connections,
    domains: {
      async findAccountByShopHandle() { return accountId },
      async setPlatform() {},
      async transition() { return undefined },
      async read() { return 'ingesting' },
      async readNormalized() { return 'acme.example' },
    },
  }
  return { ingestion: () => ingestion, now: () => new Date(today) }
}

function shopifyProduct(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Product ${id}`,
    body_html: `<p>Words about product ${id}.</p>`,
    handle: `product-${id}`,
    product_type: 'Shoes',
    tags: 'trail',
    status: 'active',
    updated_at: '2026-06-14T10:00:00Z',
    variants: [{ id: id * 10, title: 'One size', sku: `SKU-${id}`, price: '50.00', inventory_quantity: 4 }],
    images: [],
    ...overrides,
  }
}

const available = await databaseAvailable()

describe.skipIf(!available)('the nightly re-read', () => {
  beforeAll(async () => {
    harness = await setupTestDb('catalog_sweep')
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
    accountId = await insertAccount(harness.pool, `sweep-${Date.now()}@example.com`)
    await harness.pool.query(
      `insert into domains (account_id, domain_normalized, platform, state)
       values ($1, 'acme.example', 'shopify', 'ingesting')`,
      [accountId],
    )
  })

  it('converges: a second pass over an unchanged store finds nothing', async () => {
    const catalogue = [shopifyProduct(1), shopifyProduct(2), shopifyProduct(3)]

    const first = await reconcileStoreCatalog(deps(new FakeShopify([...catalogue])), { accountId })
    expect(first).toMatchObject({ productsSeen: 3, diffCount: 3, finished: true })

    const second = await reconcileStoreCatalog(
      deps(new FakeShopify([...catalogue]), new FakeConnections(accountId), '2026-06-21T03:00:00Z'),
      { accountId },
    )
    // The whole point: nothing moved, so nothing is recorded.
    expect(second).toMatchObject({ productsSeen: 3, diffCount: 0, finished: true })

    const stream = await readCatalogChanges(harness.db, system, accountId, undefined)
    expect(stream.changes).toHaveLength(3)

    const { rows } = await harness.pool.query<{ n: string }>('select count(*) as n from products')
    expect(rows[0]?.n).toBe('3')
  })

  it("fills in a store's options tonight, and asks for metafields only where something moved", async () => {
    const catalogue = [
      shopifyProduct(1, { options: [{ name: 'Size', values: ['S', 'M'] }] }),
      shopifyProduct(2, { options: [{ name: 'Size', values: ['L'] }] }),
    ]
    const first = new FakeShopify([...catalogue])
    first.metafields['1'] = [
      { namespace: 'custom', key: 'terrain', value: 'Trail', type: 'single_line_text_field' },
    ]
    await reconcileStoreCatalog(deps(first), { accountId })

    const { rows } = await harness.pool.query<{ options: unknown; metafields: unknown }>(
      'select options, metafields from products order by shopify_product_id',
    )
    expect(rows[0]?.options).toEqual([{ name: 'Size', values: ['S', 'M'] }])
    expect(rows[0]?.metafields).toEqual([
      { namespace: 'custom', key: 'terrain', value: 'Trail', type: 'single_line_text_field' },
    ])

    // A second night over an unchanged store. One extra request per product per
    // night, for ever, is what this avoids.
    const second = new FakeShopify([...catalogue])
    await reconcileStoreCatalog(
      deps(second, new FakeConnections(accountId), '2026-06-21T03:00:00Z'),
      { accountId },
    )
    expect(second.requested.filter((path) => path.includes('metafields.json'))).toEqual([])

    // And the night after an edit, it asks again for that product alone.
    const third = new FakeShopify([
      shopifyProduct(1, {
        options: [{ name: 'Size', values: ['S', 'M'] }],
        body_html: '<p>Rewritten.</p>',
        updated_at: '2026-06-21T22:00:00Z',
      }),
      catalogue[1]!,
    ])
    await reconcileStoreCatalog(
      deps(third, new FakeConnections(accountId), '2026-06-22T03:00:00Z'),
      { accountId },
    )
    expect(third.requested.filter((path) => path.includes('metafields.json'))).toEqual([
      'products/1/metafields.json?limit=250',
    ])
  })

  it('finds the edit a dropped webhook never told us about', async () => {
    const catalogue = [shopifyProduct(1), shopifyProduct(2)]
    await reconcileStoreCatalog(deps(new FakeShopify([...catalogue])), { accountId })
    const afterFirst = await readCatalogChanges(harness.db, system, accountId, undefined)

    // The merchant rewrote a description overnight and we heard nothing.
    const edited = [
      shopifyProduct(1, { body_html: '<p>Rewritten overnight.</p>', updated_at: '2026-06-19T22:00:00Z' }),
      shopifyProduct(2),
    ]
    const result = await reconcileStoreCatalog(
      deps(new FakeShopify(edited), new FakeConnections(accountId), '2026-06-21T03:00:00Z'),
      { accountId },
    )

    expect(result?.diffCount).toBe(1)
    const stream = await readCatalogChanges(harness.db, system, accountId, afterFirst.cursor)
    expect(stream.changes.map((c) => [c.kind, c.entityId])).toEqual([['product_updated', '1']])
  })

  it('does not record an edit twice when a webhook already reported it', async () => {
    // The same edit, with the same merchant edit time. The change's identity is
    // derived from that, so whichever producer sees it second writes nothing.
    const edited = shopifyProduct(1, {
      body_html: '<p>Rewritten.</p>',
      updated_at: '2026-06-19T22:00:00Z',
    })
    await reconcileStoreCatalog(deps(new FakeShopify([shopifyProduct(1)])), { accountId })
    const firstSweep = await reconcileStoreCatalog(
      deps(new FakeShopify([edited]), new FakeConnections(accountId), '2026-06-21T03:00:00Z'),
      { accountId },
    )
    expect(firstSweep?.diffCount).toBe(1)

    const again = await reconcileStoreCatalog(
      deps(new FakeShopify([edited]), new FakeConnections(accountId), '2026-06-22T03:00:00Z'),
      { accountId },
    )
    expect(again?.diffCount).toBe(0)
  })

  it('notices a product the store stopped listing, and keeps the row', async () => {
    await reconcileStoreCatalog(deps(new FakeShopify([shopifyProduct(1), shopifyProduct(2)])), {
      accountId,
    })
    const afterFirst = await readCatalogChanges(harness.db, system, accountId, undefined)

    // The next night: product 2 is gone from Shopify.
    const result = await reconcileStoreCatalog(
      deps(new FakeShopify([shopifyProduct(1)]), new FakeConnections(accountId), '2026-06-21T03:00:00Z'),
      { accountId },
    )
    expect(result?.diffCount).toBe(1)

    const stream = await readCatalogChanges(harness.db, system, accountId, afterFirst.cursor)
    expect(stream.changes.map((c) => [c.kind, c.entityId])).toEqual([['product_deleted', '2']])

    // The row stays: it is the only record that the product ever existed, which
    // is what a repair of an article referencing it would need.
    const { rows } = await harness.pool.query<{ n: string }>('select count(*) as n from products')
    expect(rows[0]?.n).toBe('2')
  })

  it('walks a large store over several runs and still finds the deletions', async () => {
    const catalogue = Array.from({ length: 5 }, (_unused, i) => shopifyProduct(i + 1))
    await reconcileStoreCatalog(deps(new FakeShopify([...catalogue])), { accountId })

    // Two products gone, and the store is read two at a time so the walk spans
    // three runs. The deletion check must still be right at the end of it.
    const shrunk = catalogue.slice(0, 3)
    const world = deps(new FakeShopify(shrunk, [], 2), new FakeConnections(accountId), '2026-06-21T03:00:00Z')
    const startedAt = '2026-06-21T03:00:00.000Z'

    let cursor: string | undefined
    let diffs = 0
    for (let run = 0; run < 5; run += 1) {
      const result = await reconcileStoreCatalog(world, { accountId, cursor, startedAt })
      diffs += result?.diffCount ?? 0
      if (result?.finished) break
      cursor = result?.cursor
    }

    expect(diffs).toBe(2)
    const stream = await readCatalogChanges(harness.db, system, accountId, undefined)
    const deletions = stream.changes.filter((c) => c.kind === 'product_deleted')
    expect(deletions.map((c) => c.entityId).sort()).toEqual(['4', '5'])
  })

  it('does nothing for a store whose connection is gone', async () => {
    const connections = new FakeConnections(accountId)
    await connections.markInvalid(accountId, new Date())
    const result = await reconcileStoreCatalog(
      deps(new FakeShopify([shopifyProduct(1)]), connections),
      { accountId },
    )
    expect(result).toBeUndefined()
  })

  it('queues a pass for every store we can still read', async () => {
    await harness.pool.query(
      `insert into shopify_conns (account_id, shop_handle, access_token, granted_scopes)
       values ($1, 'acme', 'cipher', '{read_products}')`,
      [accountId],
    )
    const other = await insertAccount(harness.pool, `dead-${Date.now()}@example.com`)
    await harness.pool.query(
      `insert into shopify_conns (account_id, shop_handle, access_token, granted_scopes, invalidated_at)
       values ($1, 'gone', 'cipher', '{read_products}', now())`,
      [other],
    )

    const result = await runReconciliationSweep({
      ...deps(new FakeShopify([])),
      syncInventory: async () => undefined,
    })
    // Only the store whose connection still works. The dead one has nothing we
    // could read.
    expect(result.accounts).toBe(1)

    const { rows } = await harness.pool.query<{ task_identifier: string }>(
      `select j.task_identifier from graphile_worker.jobs j order by j.task_identifier`,
    )
    expect(rows.map((r) => r.task_identifier)).toEqual([
      'catalog_reconcile',
      'landing_revenue_aggregate_daily',
    ])
  })

  it('brings the day takings up to date without doubling them', async () => {
    const order = {
      id: 1,
      created_at: '2026-06-19T12:00:00+00:00',
      currency: 'GBP',
      total_price: '50.00',
      landing_site: '/collections/trail-shoes',
      customer: { email: 'ada@example.com' },
      line_items: [{ product_id: 1, title: 'Product 1', quantity: 1, price: '50.00', total_discount: '0.00' }],
    }
    const world = deps(new FakeShopify([], [order]))

    await aggregateLandingRevenue(world, { accountId, days: 2 })
    await aggregateLandingRevenue(world, { accountId, days: 2 })

    const rows = await listLandingRevenue(harness.db, accountScope(accountId))
    expect(rows.map((r) => [r.date, r.landingUrl, r.ordersN, r.revenue])).toEqual([
      ['2026-06-19', '/collections/trail-shoes', 1, '50.00'],
    ])
  })
})

describe('database availability (sweep suite)', () => {
  it('reports whether the sweep tests actually ran', () => {
    if (!available) {
      throw new Error(
        'No Postgres at the test URL. The sweep tests cannot be skipped silently — ' +
          'run `pnpm db:up` first.',
      )
    }
    expect(available).toBe(true)
  })
})

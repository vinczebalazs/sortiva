import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { StoreConnection } from '@sortiva/core'
import {
  accountScope,
  listLandingRevenue,
  listTopProducts,
  readCatalogChanges,
  systemScope,
} from '@sortiva/db'
import {
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { createRun, findStep, getStep } from '../runtime/steps'
import { runStep } from '../runtime/runStep'
import { deriveIdempotencyKey } from '../runtime/idempotency'
import { catalogSyncStep, type CatalogSyncCheckpoint } from './catalog'
import type { ConnectionStore, IngestionDeps, ShopifyListReader } from './deps'

/**
 * The catalogue sync against a real database and a stand-in Shopify that pages
 * the way Shopify does.
 *
 * The test the card turns on is "crash mid-sync resumes at cursor". It is done
 * by making the stand-in store throw part-way through the walk, running the step
 * again the way a retry would, and then asserting two things: that the second
 * run did not ask for page one, and that the finished catalogue is identical to
 * one read without an interruption.
 */

let harness: TestDb
let accountId: string

const system = systemScope('the catalogue sync tests read the change stream')

/** A store whose products and orders are paged out the way Shopify pages them. */
class FakeShopify implements ShopifyListReader {
  readonly requested: string[] = []
  private failAfter: number | undefined
  private failures = 0

  constructor(
    private readonly products: Record<string, unknown>[],
    private readonly orders: Record<string, unknown>[] = [],
    private readonly pageSize = 2,
  ) {}

  /** Dies once, after this many requests. The next run starts from the checkpoint. */
  diesAfter(requests: number): this {
    this.failAfter = requests
    return this
  }

  get failureCount(): number {
    return this.failures
  }

  async getPage<T>(
    _auth: { shop: string; accessToken: string },
    path: string,
  ): Promise<{ body: T; nextPageInfo: string | undefined }> {
    this.requested.push(path)
    if (this.failAfter !== undefined && this.requested.length > this.failAfter) {
      this.failAfter = undefined
      this.failures += 1
      throw new Error('the worker died mid-page')
    }

    const list = path.startsWith('orders.json') ? this.orders : this.products
    const key = path.startsWith('orders.json') ? 'orders' : 'products'
    const offset = Number(new URLSearchParams(path.split('?')[1] ?? '').get('page_info') ?? '0')
    const slice = list.slice(offset, offset + this.pageSize)
    const next = offset + this.pageSize < list.length ? String(offset + this.pageSize) : undefined
    return { body: { [key]: slice } as T, nextPageInfo: next }
  }
}

function shopifyProduct(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Product ${id}`,
    body_html: `<p>Words about product ${id}.</p>`,
    handle: `product-${id}`,
    product_type: 'Shoes',
    vendor: 'Ridgeline',
    tags: 'trail',
    status: 'active',
    updated_at: '2026-06-14T10:00:00Z',
    variants: [{ id: id * 10, title: 'One size', sku: `SKU-${id}`, price: '50.00', inventory_quantity: 4 }],
    images: [],
    ...overrides,
  }
}

function shopifyOrder(id: number, day: string, productId: number, quantity: number, total: string) {
  return {
    id,
    created_at: `${day}T12:00:00+00:00`,
    currency: 'GBP',
    total_price: total,
    landing_site: '/collections/trail-shoes',
    // The stand-in sends what Shopify sends, customer record and all, so the
    // stripping is exercised by the real path rather than by a tidied fixture.
    email: 'ada@example.com',
    customer: { id: 1, email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' },
    shipping_address: { address1: '12 Marylebone Road', city: 'London', zip: 'NW1 5LA' },
    browser_ip: '203.0.113.42',
    line_items: [
      { product_id: productId, title: `Product ${productId}`, quantity, price: '50.00', total_discount: '0.00' },
    ],
  }
}

class FakeConnections implements ConnectionStore {
  private connection: StoreConnection

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
    return 'shpat_test'
  }

  async markInvalid(_accountId: string, at: Date): Promise<Date> {
    this.connection = { ...this.connection, invalidatedAt: at }
    return at
  }
}

function deps(admin: ShopifyListReader, today = '2026-06-20T03:00:00Z'): IngestionDeps {
  return {
    db: harness.db,
    pool: harness.pool,
    fetcher: { async fetch() { throw new Error('the catalogue sync makes no page fetches') } },
    shopify: { authorizeUrl: () => '', verifyCallbackSignature: () => true, exchangeCode: async () => ({ accessToken: '', grantedScopes: [] }), revokeAccess: async () => {} },
    shop: { async getShop() { throw new Error('not used') } },
    admin,
    connections: new FakeConnections(accountId),
    domains: {
      async findAccountByShopHandle() { return accountId },
      async setPlatform() {},
      async transition() { return undefined },
      async read() { return 'ingesting' },
      async readNormalized() { return 'acme.example' },
    },
    now: () => new Date(today),
  }
}

/**
 * Runs the step the way the dispatcher does, so the ledger, the per-account lock
 * and the guarded transitions all engage.
 *
 * `on` re-runs an existing step row, which is what a retry after a crash
 * actually is — a fresh run would have a fresh, empty checkpoint and would prove
 * nothing about resuming.
 */
async function runCatalogSync(world: IngestionDeps, on?: { jobId: string; stepId: string }) {
  let target = on
  if (!target) {
    const run = await createRun(harness.db, accountId, `run-${Date.now()}-${Math.random()}`)
    await harness.pool.query(
      `update job_steps set state = 'succeeded' where job_id = $1 and step in ('detect','oauth_wait')`,
      [run.jobId],
    )
    const step = await findStep(harness.db, run.jobId, 'catalog_sync')
    target = { jobId: run.jobId, stepId: step!.id }
  }
  // A retry is offered again once its backoff has elapsed; the test does not
  // wait a minute for that.
  await harness.pool.query(`update job_steps set next_attempt_at = null where id = $1`, [
    target.stepId,
  ])
  const key = deriveIdempotencyKey(
    accountId,
    'catalog_sync',
    await catalogSyncStep.inputVersion(world, accountId),
  )
  const outcome = await runStep<CatalogSyncCheckpoint>({
    db: harness.db,
    pool: harness.pool,
    accountId,
    jobId: target.jobId,
    stepId: target.stepId,
    idempotencyKey: key,
    handler: (ctx) => catalogSyncStep.execute(world, ctx),
  })
  return { outcome, stepId: target.stepId, jobId: target.jobId }
}

const available = await databaseAvailable()

describe.skipIf(!available)('reading a whole store', () => {
  beforeAll(async () => {
    harness = await setupTestDb('catalog_sync')
  }, 60_000)

  afterAll(async () => {
    await harness?.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    accountId = await insertAccount(harness.pool, `sync-${Date.now()}@example.com`)
    await harness.pool.query(
      `insert into domains (account_id, domain_normalized, platform, state)
       values ($1, 'acme.example', 'shopify', 'ingesting')`,
      [accountId],
    )
  })

  it('walks every page of the catalogue and records what it found', async () => {
    const shopify = new FakeShopify([shopifyProduct(1), shopifyProduct(2), shopifyProduct(3)])
    const { outcome } = await runCatalogSync(deps(shopify))

    expect(outcome.status).toBe('succeeded')
    const { rows } = await harness.pool.query<{ n: string }>('select count(*) as n from products')
    expect(rows[0]?.n).toBe('3')

    // Every product is new, so every product is a change the stream reports.
    const stream = await readCatalogChanges(harness.db, system, accountId, undefined)
    expect(stream.changes.map((c) => c.kind)).toEqual([
      'product_created',
      'product_created',
      'product_created',
    ])
  })

  it("asks the store for its own option axes and keeps them", async () => {
    const shopify = new FakeShopify([
      shopifyProduct(1, {
        options: [
          { name: 'Size', position: 1, values: ['UK 8', 'UK 9'] },
          { name: 'Colour', position: 2, values: ['Black', 'Tan'] },
        ],
      }),
    ])
    const { outcome } = await runCatalogSync(deps(shopify))
    expect(outcome.status).toBe('succeeded')

    // Asked for by name: without it in the field list Shopify sends the product
    // back with no options at all and the store's best-organised data is lost.
    expect(shopify.requested[0]).toContain('options')

    const { rows } = await harness.pool.query<{ options: unknown }>('select options from products')
    expect(rows[0]?.options).toEqual([
      { name: 'Size', values: ['UK 8', 'UK 9'] },
      { name: 'Colour', values: ['Black', 'Tan'] },
    ])
  })

  it('leaves a store that publishes no options exactly as it was', async () => {
    const shopify = new FakeShopify([shopifyProduct(1)])
    await runCatalogSync(deps(shopify))
    const { rows } = await harness.pool.query<{ options: unknown }>('select options from products')
    expect(rows[0]?.options).toEqual([])
  })

  it('resumes at the page it reached rather than at the first one', async () => {
    // Three pages of two products. The store dies after the second request,
    // which is part-way through the walk.
    const shopify = new FakeShopify(
      [1, 2, 3, 4, 5, 6].map((id) => shopifyProduct(id)),
      [],
      2,
    )
    shopify.diesAfter(2)

    const first = await runCatalogSync(deps(shopify))
    expect(first.outcome.status).toBe('retry_scheduled')

    const checkpoint = (await getStep(harness.db, first.stepId))?.checkpoint as CatalogSyncCheckpoint
    expect(checkpoint.phase).toBe('products')
    expect(checkpoint.productsSeen).toBe(4)
    expect(checkpoint.productPage).toBe('4')

    const { rows: afterCrash } = await harness.pool.query<{ n: string }>(
      'select count(*) as n from products',
    )
    // The work done before the crash is on disk, not lost.
    expect(afterCrash[0]?.n).toBe('4')

    // Now the retry, from the saved position.
    const requestsBefore = shopify.requested.length
    const second = await runCatalogSync(deps(shopify), first)
    expect(second.outcome.status).toBe('succeeded')

    const resumedWith = shopify.requested.slice(requestsBefore)
    // The proof: the first thing the second run asked for was the page the
    // first run stopped at, not page one.
    expect(resumedWith[0]).toContain('page_info=4')
    expect(resumedWith.filter((path) => path.startsWith('products.json') && !path.includes('page_info'))).toEqual([])

    const { rows: finished } = await harness.pool.query<{ n: string }>(
      'select count(*) as n from products',
    )
    expect(finished[0]?.n).toBe('6')
  })

  it('lands on the same catalogue as a run that was never interrupted', async () => {
    const catalogue = [1, 2, 3, 4, 5, 6].map((id) => shopifyProduct(id))

    const interrupted = new FakeShopify([...catalogue], [], 2)
    interrupted.diesAfter(2)
    const killed = await runCatalogSync(deps(interrupted))
    await runCatalogSync(deps(interrupted), killed)
    const { rows: withCrash } = await harness.pool.query<{ shopify_product_id: string; checksum: string }>(
      'select shopify_product_id, checksum from products order by shopify_product_id',
    )
    const changesWithCrash = await readCatalogChanges(harness.db, system, accountId, undefined)

    await truncateAll(harness.pool)
    accountId = await insertAccount(harness.pool, `clean-${Date.now()}@example.com`)
    await harness.pool.query(
      `insert into domains (account_id, domain_normalized, platform, state)
       values ($1, 'acme.example', 'shopify', 'ingesting')`,
      [accountId],
    )
    await runCatalogSync(deps(new FakeShopify([...catalogue], [], 2)))
    const { rows: clean } = await harness.pool.query<{ shopify_product_id: string; checksum: string }>(
      'select shopify_product_id, checksum from products order by shopify_product_id',
    )
    const changesClean = await readCatalogChanges(harness.db, system, accountId, undefined)

    expect(withCrash).toEqual(clean)
    expect(changesWithCrash.changes.map((c) => [c.kind, c.entityId])).toEqual(
      changesClean.changes.map((c) => [c.kind, c.entityId]),
    )
  })

  it('reports nothing changed when the same store is read again', async () => {
    const catalogue = [shopifyProduct(1), shopifyProduct(2)]
    await runCatalogSync(deps(new FakeShopify([...catalogue])))
    const firstPass = await readCatalogChanges(harness.db, system, accountId, undefined)

    // A second night, nothing edited in between.
    await runCatalogSync(deps(new FakeShopify([...catalogue]), '2026-06-21T03:00:00Z'))
    const secondPass = await readCatalogChanges(harness.db, system, accountId, firstPass.cursor)

    expect(secondPass.changes).toEqual([])
  })

  it('tells a rewrite apart from a price change on the second read', async () => {
    await runCatalogSync(deps(new FakeShopify([shopifyProduct(1)])))
    const afterFirst = await readCatalogChanges(harness.db, system, accountId, undefined)

    const repriced = shopifyProduct(1, {
      updated_at: '2026-06-15T10:00:00Z',
      variants: [{ id: 10, title: 'One size', sku: 'SKU-1', price: '25.00', inventory_quantity: 4 }],
    })
    // The next night. A run on the same day is the same work by design and the
    // ledger answers for it without reading the store again.
    await runCatalogSync(deps(new FakeShopify([repriced]), '2026-06-21T03:00:00Z'))

    const stream = await readCatalogChanges(harness.db, system, accountId, afterFirst.cursor)
    expect(stream.changes.map((c) => c.kind)).toEqual(['price_changed'])
  })

  it('computes best sellers and daily takings, holding nothing about the buyers', async () => {
    const shopify = new FakeShopify(
      [shopifyProduct(1), shopifyProduct(2)],
      [
        shopifyOrder(9001, '2026-06-01', 1, 1, '50.00'),
        shopifyOrder(9002, '2026-06-01', 2, 4, '200.00'),
        shopifyOrder(9003, '2026-06-02', 2, 1, '50.00'),
      ],
      2,
    )
    const { outcome } = await runCatalogSync(deps(shopify))
    expect(outcome.status).toBe('succeeded')

    const scope = accountScope(accountId)
    const top = await listTopProducts(harness.db, scope)
    expect(top.map((row) => [row.title, row.rank, row.revenue90d, row.qty90d])).toEqual([
      ['Product 2', 1, '250.00', 5],
      ['Product 1', 2, '50.00', 1],
    ])

    const revenue = await listLandingRevenue(harness.db, scope)
    expect(revenue.map((row) => [row.date, row.landingUrl, row.ordersN, row.revenue])).toEqual([
      ['2026-06-01', '/collections/trail-shoes', 2, '250.00'],
      ['2026-06-02', '/collections/trail-shoes', 1, '50.00'],
    ])

    // Invariant 4, asserted against the database rather than against a function:
    // nothing a buyer could be identified by is anywhere in what we wrote.
    const dump = await harness.pool.query<{ dump: string }>(
      `select coalesce(string_agg(t.txt, ' '), '') as dump from (
         select row_to_json(top_products)::text as txt from top_products
         union all select row_to_json(landing_revenue_daily)::text from landing_revenue_daily
         union all select row_to_json(products)::text from products
       ) t`,
    )
    for (const value of ['ada@example.com', 'Lovelace', 'Marylebone', '203.0.113.42']) {
      expect(dump.rows[0]?.dump, `"${value}" reached storage`).not.toContain(value)
    }
  })

  it('asks Shopify for no field that could name a buyer', async () => {
    const shopify = new FakeShopify([shopifyProduct(1)], [shopifyOrder(9001, '2026-06-01', 1, 1, '50.00')])
    await runCatalogSync(deps(shopify))

    const orderRequests = shopify.requested.filter((path) => path.startsWith('orders.json'))
    expect(orderRequests.length).toBeGreaterThan(0)
    for (const field of ['customer', 'email', 'phone', 'shipping_address', 'billing_address', 'client_details']) {
      expect(orderRequests[0], `we asked Shopify for ${field}`).not.toContain(field)
    }
  })

  it('does not walk the store twice when the same night work is redelivered', async () => {
    const shopify = new FakeShopify([shopifyProduct(1), shopifyProduct(2)])
    await runCatalogSync(deps(shopify))
    const requestsAfterFirst = shopify.requested.length

    // A redelivery: the same account, the same day, so the same derived key.
    const second = await runCatalogSync(deps(shopify))
    expect(second.outcome.status).toBe('succeeded')
    expect(shopify.requested.length).toBe(requestsAfterFirst)
  })
})

describe('database availability (catalogue sync suite)', () => {
  it('reports whether the catalogue sync tests actually ran', () => {
    if (!available) {
      throw new Error(
        'No Postgres at the test URL. The catalogue sync tests cannot be skipped silently — ' +
          'run `pnpm db:up` first.',
      )
    }
    expect(available).toBe(true)
  })
})

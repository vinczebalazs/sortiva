import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ORDER_WINDOW_DAYS,
  staticShopifyAuth,
  type ShopifyAuth,
  type ShopifyOAuthProvider,
  type ShopifyOrder,
  type ShopifyProduct,
  type StoreConnection,
} from '@sortiva/core'
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
import { ShopifyAccessDenied, ShopifyTokenInvalid } from '@sortiva/providers'
import { createRun, findStep, getStep } from '../runtime/steps'
import { runStep } from '../runtime/runStep'
import { deriveIdempotencyKey } from '../runtime/idempotency'
import { catalogSyncStep, type CatalogSyncCheckpoint, type CatalogSyncOutput } from './catalog'
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

/** One thing the sync asked the store for, as the stand-in saw it. */
interface ListRequest {
  readonly list: 'products' | 'orders'
  /** The cursor the request carried, or undefined for the first page. */
  readonly after: string | undefined
  /** For an order read: the start of the window that was asked for. */
  readonly createdFrom?: Date
}

/**
 * A store whose products and orders are paged out the way Shopify pages them.
 *
 * Both reads are semantic now — "the next page of products", not a URL — so
 * what a test asserts against is the list of asks: which list, and from which
 * cursor.
 */
class FakeShopify implements ShopifyListReader {
  readonly requests: ListRequest[] = []
  private failAfter: number | undefined
  private failures = 0
  private tokenDies = false
  private ordersRefused = false

  constructor(
    private readonly products: ShopifyProduct[],
    private readonly orders: ShopifyOrder[] = [],
    private readonly pageSize = 2,
    /** The store's own time zone, which decides which calendar day an order belongs to. */
    private readonly timeZone: string | null = 'Europe/London',
  ) {}

  /**
   * Dies once, after this many list requests. The next run starts from the
   * checkpoint.
   */
  diesAfter(requests: number): this {
    this.failAfter = requests
    return this
  }

  /** From here on every read answers the way Shopify does once a token is dead. */
  rejectsToken(): this {
    this.tokenDies = true
    return this
  }

  /**
   * Shopify has not approved this store's order data. Products still read;
   * orders answer with the refusal that approval is pending.
   */
  refusesOrders(): this {
    this.ordersRefused = true
    return this
  }

  get failureCount(): number {
    return this.failures
  }

  async listProducts(
    _auth: ShopifyAuth,
    options: { after?: string; first?: number } = {},
  ): Promise<{ items: readonly ShopifyProduct[]; next: string | undefined }> {
    this.record({ list: 'products', after: options.after })
    return this.page(this.products, options.after)
  }

  async listOrders(
    _auth: ShopifyAuth,
    options: { createdFrom: Date; after?: string; first?: number },
  ): Promise<{ items: readonly ShopifyOrder[]; next: string | undefined; timeZone: string | null }> {
    this.record({ list: 'orders', after: options.after, createdFrom: options.createdFrom })
    if (this.ordersRefused) {
      throw new ShopifyAccessDenied('acme', 'this app is not approved for protected customer data')
    }
    return { ...this.page(this.orders, options.after), timeZone: this.timeZone }
  }

  private record(request: ListRequest): void {
    this.requests.push(request)
    if (this.tokenDies) throw new ShopifyTokenInvalid('acme', 401)
    if (this.failAfter !== undefined && this.requests.length > this.failAfter) {
      this.failAfter = undefined
      this.failures += 1
      throw new Error('the worker died mid-page')
    }
  }

  /** One page, and the cursor the page after it starts at. */
  private page<T>(list: readonly T[], after: string | undefined): { items: readonly T[]; next: string | undefined } {
    const offset = after ? Number(after.replace('cursor-', '')) : 0
    const items = list.slice(offset, offset + this.pageSize)
    const nextOffset = offset + this.pageSize
    return { items, next: nextOffset < list.length ? `cursor-${nextOffset}` : undefined }
  }
}

/**
 * A product as the Admin client hands it over: its variants, its option axes
 * and its metafields all travel with it, which is what makes a page of the
 * catalogue one request rather than one plus one per product.
 */
function shopifyProduct(id: number, overrides: Partial<ShopifyProduct> = {}): ShopifyProduct {
  return {
    id: String(id),
    title: `Product ${id}`,
    body_html: `<p>Words about product ${id}.</p>`,
    handle: `product-${id}`,
    product_type: 'Shoes',
    vendor: 'Ridgeline',
    tags: 'trail',
    status: 'active',
    updated_at: '2026-06-14T10:00:00Z',
    variants: [
      { id: id * 10, title: 'One size', sku: `SKU-${id}`, price: '50.00', available: true },
    ],
    images: [],
    options: [],
    metafields: [],
    ...overrides,
  }
}

function shopifyOrder(
  id: number,
  day: string,
  productId: number,
  quantity: number,
  unitPrice = '50.00',
  overrides: Partial<ShopifyOrder> = {},
): ShopifyOrder {
  return {
    id: String(id),
    createdAt: `${day}T12:00:00Z`,
    currency: 'GBP',
    landingPage: '/collections/trail-shoes',
    cancelledAt: null,
    test: false,
    lineItems: [
      {
        productId: String(productId),
        title: `Product ${productId}`,
        quantity,
        unitPrice,
        isGiftCard: false,
      },
    ],
    ...overrides,
  }
}

/**
 * The same order with a shopper attached to it, the way a client that had
 * stopped being careful would hand it over. Nothing of it may reach anything we
 * keep — not the tables, and not the checkpoint the walk saves as it goes.
 */
function withBuyer(order: ShopifyOrder): ShopifyOrder {
  return {
    ...order,
    email: 'ada@example.com',
    customer: { id: 1, email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' },
    shipping_address: { address1: '12 Marylebone Road', city: 'London', zip: 'NW1 5LA' },
    browser_ip: '203.0.113.42',
  } as ShopifyOrder
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

  async authFor(): Promise<ShopifyAuth | undefined> {
    return this.connection.invalidatedAt === null
      ? staticShopifyAuth(this.connection.shopHandle, 'shpat_test')
      : undefined
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
    shopify: alreadyInstalled,
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

    // The axes come back with the product rather than being asked for
    // separately, so what this proves is that they survive the write: without
    // them a store's best-organised data is the one thing we could not describe.
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

  it("reads the attributes a store keeps in metafields, which travel with the product", async () => {
    const shopify = new FakeShopify([
      shopifyProduct(1, {
        metafields: [
          { namespace: 'custom', key: 'terrain', value: 'Technical trail', type: 'single_line_text_field' },
        ],
      }),
    ])

    const { outcome } = await runCatalogSync(deps(shopify))
    expect(outcome.status).toBe('succeeded')

    // One page of the catalogue, one request. The attributes arrived inside it.
    expect(shopify.requests.filter((r) => r.list === 'products')).toHaveLength(1)

    const { rows } = await harness.pool.query<{ metafields: unknown }>(
      'select metafields from products',
    )
    expect(rows[0]?.metafields).toEqual([
      { namespace: 'custom', key: 'terrain', value: 'Technical trail', type: 'single_line_text_field' },
    ])
  })

  it('costs one request per page of the catalogue and nothing at all per product', async () => {
    const catalogue = [1, 2, 3, 4].map((id) =>
      shopifyProduct(id, {
        metafields: [{ namespace: 'custom', key: 'terrain', value: 'Trail', type: 'single_line_text_field' }],
      }),
    )
    const shopify = new FakeShopify([...catalogue])
    await runCatalogSync(deps(shopify))

    // Four products, two to a page: two product reads and one order read, and
    // nothing else. A request per product per night, for ever, is the cost this
    // shape of read exists to avoid.
    expect(shopify.requests.map((r) => r.list)).toEqual(['products', 'products', 'orders'])

    // And the second night over an unchanged store costs exactly the same.
    const second = new FakeShopify([...catalogue])
    await runCatalogSync(deps(second, '2026-06-21T03:00:00Z'))
    expect(second.requests).toHaveLength(shopify.requests.length)
  })

  it('finishes the walk, keeping what it holds, when a product arrives without its attributes', async () => {
    // A read that did not carry metafields is not the same as a product having
    // none: writing "none" over what we hold would lose a store's own
    // attributes on the first read that came back light.
    const first = new FakeShopify([
      shopifyProduct(1, {
        metafields: [{ namespace: 'custom', key: 'fit', value: 'Wide', type: 'single_line_text_field' }],
      }),
    ])
    await runCatalogSync(deps(first))

    const light = shopifyProduct(1, { updated_at: '2026-06-16T10:00:00Z' })
    delete (light as { metafields?: unknown }).metafields
    const second = new FakeShopify([light, shopifyProduct(2)])

    const { outcome } = await runCatalogSync(deps(second, '2026-06-21T03:00:00Z'))
    expect(outcome.status).toBe('succeeded')

    const { rows } = await harness.pool.query<{ shopify_product_id: string; metafields: unknown }>(
      'select shopify_product_id, metafields from products order by shopify_product_id',
    )
    // Left as it was rather than written as "none".
    expect(rows[0]?.metafields).toEqual([
      { namespace: 'custom', key: 'fit', value: 'Wide', type: 'single_line_text_field' },
    ])
    expect(rows[1]?.metafields).toEqual([])
  })

  it('stops for a dead token rather than grinding through a store it can no longer read', async () => {
    // The one failure that is not this page's problem: it is the store's, and it
    // sends the merchant to the reconnect screen. Swallowing it here would leave
    // the walk asking a store that has stopped answering.
    const shopify = new FakeShopify([shopifyProduct(1)]).rejectsToken()

    const { outcome } = await runCatalogSync(deps(shopify))
    expect(outcome.status).toBe('awaiting_reauth')
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
    expect(checkpoint.productPage).toBe('cursor-4')

    const { rows: afterCrash } = await harness.pool.query<{ n: string }>(
      'select count(*) as n from products',
    )
    // The work done before the crash is on disk, not lost.
    expect(afterCrash[0]?.n).toBe('4')

    // Now the retry, from the saved position.
    const requestsBefore = shopify.requests.length
    const second = await runCatalogSync(deps(shopify), first)
    expect(second.outcome.status).toBe('succeeded')

    const resumedWith = shopify.requests.slice(requestsBefore)
    // The proof: the first thing the second run asked for was the page the
    // first run stopped at, not page one.
    expect(resumedWith[0]).toMatchObject({ list: 'products', after: 'cursor-4' })
    expect(
      resumedWith.filter((request) => request.list === 'products' && request.after === undefined),
    ).toEqual([])

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
      variants: [{ id: 10, title: 'One size', sku: 'SKU-1', price: '25.00', available: true }],
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
        withBuyer(shopifyOrder(9001, '2026-06-01', 1, 1)),
        withBuyer(shopifyOrder(9002, '2026-06-01', 2, 4)),
        withBuyer(shopifyOrder(9003, '2026-06-02', 2, 1)),
      ],
      2,
    )
    const { outcome } = await runCatalogSync(deps(shopify))
    expect(outcome.status).toBe('succeeded')

    const scope = accountScope(accountId)
    const top = await listTopProducts(harness.db, scope)
    // What the store earned on the lines themselves — after discounts, refunds
    // and removals, and without tax or postage, which are not the product's.
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
    // nothing a buyer could be identified by is anywhere in what we wrote —
    // including the checkpoint the walk saves as it goes, which is a row like
    // any other.
    const dump = await harness.pool.query<{ dump: string }>(
      `select coalesce(string_agg(t.txt, ' '), '') as dump from (
         select row_to_json(top_products)::text as txt from top_products
         union all select row_to_json(landing_revenue_daily)::text from landing_revenue_daily
         union all select row_to_json(products)::text from products
         union all select row_to_json(job_steps)::text from job_steps
       ) t`,
    )
    for (const value of ['ada@example.com', 'Lovelace', 'Marylebone', '203.0.113.42']) {
      expect(dump.rows[0]?.dump, `"${value}" reached storage`).not.toContain(value)
    }
  })

  it('asks for sixty days of orders, which is as far back as Shopify lets us read', async () => {
    const shopify = new FakeShopify([shopifyProduct(1)], [shopifyOrder(9001, '2026-06-01', 1, 1)])
    await runCatalogSync(deps(shopify))

    const orderReads = shopify.requests.filter((request) => request.list === 'orders')
    expect(orderReads.length).toBeGreaterThan(0)
    expect(ORDER_WINDOW_DAYS).toBe(60)
    // Reading further back needs an approval Shopify grants case by case;
    // asking for more without it silently returned sixty days under labels that
    // said ninety.
    const asked = orderReads[0]!.createdFrom!
    const expected = new Date(Date.parse('2026-06-20T03:00:00Z') - 60 * 86_400_000)
    expect(asked.toISOString()).toBe(expected.toISOString())
  })

  it('counts an order on the day it was placed where the merchant lives', async () => {
    // Eight in the evening in Los Angeles is already tomorrow in UTC. Counting
    // it as tomorrow's takings would misplace every evening order the store
    // ever takes.
    const shopify = new FakeShopify(
      [shopifyProduct(1)],
      [
        {
          ...shopifyOrder(9001, '2026-06-01', 1, 1),
          createdAt: '2026-06-02T03:00:00Z',
        },
      ],
      2,
      'America/Los_Angeles',
    )
    const { outcome } = await runCatalogSync(deps(shopify))
    expect(outcome.status).toBe('succeeded')

    const revenue = await listLandingRevenue(harness.db, accountScope(accountId))
    expect(revenue.map((row) => row.date)).toEqual(['2026-06-01'])
  })

  it('finishes with a catalogue and no best sellers when Shopify will not show us the orders', async () => {
    // Shopify treats everything about an order as customer data and approves
    // access store by store. Until that approval comes through the merchant
    // still gets their catalogue, rather than onboarding stopping at a wall
    // they cannot climb.
    const shopify = new FakeShopify(
      [shopifyProduct(1), shopifyProduct(2)],
      [shopifyOrder(9001, '2026-06-01', 1, 1)],
    ).refusesOrders()

    const { outcome } = await runCatalogSync(deps(shopify))

    expect(outcome.status).toBe('succeeded')
    const output = (outcome as { status: 'succeeded'; output: CatalogSyncOutput }).output
    expect(output.ordersUnavailable).toBe(true)
    expect(output.productsSeen).toBe(2)
    expect(output.topProducts).toBe(0)

    const { rows } = await harness.pool.query<{ n: string }>('select count(*) as n from products')
    expect(rows[0]?.n).toBe('2')
    expect(await listTopProducts(harness.db, accountScope(accountId))).toEqual([])
  })

  it('takes one refusal as the answer rather than knocking page after page', async () => {
    const shopify = new FakeShopify(
      [shopifyProduct(1)],
      // Enough orders for several pages, had we been allowed to read any of them.
      [1, 2, 3, 4].map((n) => shopifyOrder(9000 + n, '2026-06-01', 1, 1)),
      2,
    ).refusesOrders()

    const { outcome, stepId } = await runCatalogSync(deps(shopify))
    expect(outcome.status).toBe('succeeded')

    expect(shopify.requests.filter((request) => request.list === 'orders')).toHaveLength(1)
    // And it is written down, so a run picked up from this point does not ask
    // again either.
    const checkpoint = (await getStep(harness.db, stepId))?.checkpoint as CatalogSyncCheckpoint
    expect(checkpoint.ordersUnavailable).toBe(true)
  })

  it('does not walk the store twice when the same night work is redelivered', async () => {
    const shopify = new FakeShopify([shopifyProduct(1), shopifyProduct(2)])
    await runCatalogSync(deps(shopify))
    const requestsAfterFirst = shopify.requests.length

    // A redelivery: the same account, the same day, so the same derived key.
    const second = await runCatalogSync(deps(shopify))
    expect(second.outcome.status).toBe('succeeded')
    expect(shopify.requests.length).toBe(requestsAfterFirst)
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

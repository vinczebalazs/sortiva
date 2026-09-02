import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { accountScope, systemScope } from './scope'
import {
  accountsWithLiveShopifyConnectionAndHandle,
  listLandingRevenue,
  listTopProducts,
  markWebhookProcessed,
  productIdsByShopifyId,
  readCatalogChanges,
  readProductBody,
  recordCatalogChange,
  recordCatalogChanges,
  replaceTopProducts,
  storedProductStates,
  unprocessedWebhooks,
  upsertLandingRevenue,
  upsertProducts,
} from './repositories'
import { recordWebhookEvent } from './repositories/system'
import { databaseAvailable, insertAccount, setupTestDb, type TestDb } from './testing'

const available = await databaseAvailable()

describe.skipIf(!available)('the catalogue as we hold it', () => {
  let ctx: TestDb
  let accountId: string
  let scope: ReturnType<typeof accountScope>
  const system = systemScope('the catalogue tests read across accounts')

  beforeAll(async () => {
    ctx = await setupTestDb('catalog')
  }, 60_000)

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await ctx.pool.query('truncate accounts cascade')
    await ctx.pool.query('truncate webhook_events')
    accountId = await insertAccount(ctx.pool, `catalog-${Date.now()}@example.com`)
    scope = accountScope(accountId)
  })

  const product = (id: string, checksum: string) => ({
    shopifyProductId: id,
    title: `Product ${id}`,
    rawBodyHtml: '<p>Words about the product.</p>',
    productType: 'Shoes',
    tags: ['trail'],
    variants: [{ id: '1', price: 120, available: true }],
    priceRange: { min: 120, max: 120 },
    updatedAt: new Date('2026-06-14T10:00:00Z'),
    checksum,
  })

  it('writes a product once however many times the same page is read', async () => {
    await upsertProducts(ctx.db, scope, [product('700', 'aaa')])
    await upsertProducts(ctx.db, scope, [product('700', 'aaa')])

    const states = await storedProductStates(ctx.db, scope)
    expect(states.size).toBe(1)
    expect(states.get('700')?.checksum).toBe('aaa')
  })

  it('replaces what it holds when the product changed', async () => {
    await upsertProducts(ctx.db, scope, [product('700', 'aaa')])
    await upsertProducts(ctx.db, scope, [{ ...product('700', 'bbb'), title: 'Renamed' }])

    const states = await storedProductStates(ctx.db, scope)
    expect(states.get('700')?.checksum).toBe('bbb')
    const { rows } = await ctx.pool.query<{ title: string }>('select title from products')
    expect(rows[0]?.title).toBe('Renamed')
  })

  it('keeps the grouping a later step decided, rather than clearing it every night', async () => {
    await upsertProducts(ctx.db, scope, [product('700', 'aaa')])
    const { rows: familyRows } = await ctx.pool.query<{ id: string }>(
      `insert into product_families (account_id, name, grouping_source, confidence)
       values ($1, 'Trail shoes', 'fact_cluster', 'high') returning id`,
      [accountId],
    )
    const familyId = familyRows[0]!.id
    await ctx.pool.query('update products set family_id = $1', [familyId])

    await upsertProducts(ctx.db, scope, [product('700', 'ccc')])

    const { rows } = await ctx.pool.query<{ family_id: string | null }>(
      'select family_id from products',
    )
    expect(rows[0]?.family_id).toBe(familyId)
  })

  it('stores the quarantined description compressed and reads it back', async () => {
    await upsertProducts(ctx.db, scope, [product('700', 'aaa')])
    const { rows } = await ctx.pool.query<{ raw_body_html: Buffer }>(
      'select raw_body_html from products',
    )
    expect(readProductBody({ rawBodyHtml: rows[0]!.raw_body_html })).toBe(
      '<p>Words about the product.</p>',
    )
  })

  it('replaces the best-seller list rather than accumulating it', async () => {
    await upsertProducts(ctx.db, scope, [
      product('700', 'a'),
      product('701', 'b'),
      product('702', 'c'),
    ])
    const ids = await productIdsByShopifyId(ctx.db, scope, ['700', '701', '702'])

    await replaceTopProducts(ctx.db, scope, [
      { productId: ids.get('700')!, title: 'A', url: null, revenue90d: 500, qty90d: 1, rank: 1 },
      { productId: ids.get('701')!, title: 'B', url: null, revenue90d: 250, qty90d: 25, rank: 2 },
    ])
    // The second month: one seller has dropped out and a new one has arrived.
    await replaceTopProducts(ctx.db, scope, [
      { productId: ids.get('702')!, title: 'C', url: null, revenue90d: 900, qty90d: 3, rank: 1 },
      { productId: ids.get('700')!, title: 'A', url: null, revenue90d: 100, qty90d: 1, rank: 2 },
    ])

    const rows = await listTopProducts(ctx.db, scope)
    expect(rows.map((r) => [r.title, r.rank, r.revenue90d])).toEqual([
      ['C', 1, '900.00'],
      ['A', 2, '100.00'],
    ])
  })

  it('writes the day takings as a replacement, so a re-read cannot double them', async () => {
    const day = [
      { date: '2026-06-01', landingUrl: '/collections/boots', ordersN: 2, revenue: 25.5, currency: 'EUR' },
    ]
    await upsertLandingRevenue(ctx.db, scope, day)
    await upsertLandingRevenue(ctx.db, scope, day)

    const rows = await listLandingRevenue(ctx.db, scope)
    expect(rows).toHaveLength(1)
    expect([rows[0]?.ordersN, rows[0]?.revenue]).toEqual([2, '25.50'])
  })

  it('lists only the stores whose connection still works', async () => {
    await ctx.pool.query(
      `insert into shopify_conns (account_id, shop_handle, access_token, granted_scopes)
       values ($1, 'acme', 'cipher', '{read_products}')`,
      [accountId],
    )
    expect(await accountsWithLiveShopifyConnectionAndHandle(ctx.db, system)).toEqual([
      { accountId, shopHandle: 'acme' },
    ])

    await ctx.pool.query('update shopify_conns set invalidated_at = now()')
    expect(await accountsWithLiveShopifyConnectionAndHandle(ctx.db, system)).toEqual([])
  })
})

describe.skipIf(!available)('the change stream', () => {
  let ctx: TestDb
  let accountId: string
  let otherAccountId: string
  const system = systemScope('the change-stream tests read across accounts')

  beforeAll(async () => {
    ctx = await setupTestDb('catalog_changes')
  }, 60_000)

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await ctx.pool.query('truncate accounts cascade')
    await ctx.pool.query('truncate webhook_events')
    accountId = await insertAccount(ctx.pool, `stream-${Date.now()}@example.com`)
    otherAccountId = await insertAccount(ctx.pool, `other-${Date.now()}@example.com`)
  })

  const change = (kind: string, entityId: string, occurredAt: string, account = accountId) => ({
    accountId: account,
    shopHandle: 'acme',
    kind,
    entityId,
    occurredAt,
    changedFields: ['body_html'],
  })

  it('records a change once however many times it is found', async () => {
    expect(await recordCatalogChange(ctx.db, system, change('product_updated', '700', '2026-06-14T10:00:00.000Z'))).toBe(true)
    // The nightly sweep finding the same edit a webhook already reported.
    expect(await recordCatalogChange(ctx.db, system, change('product_updated', '700', '2026-06-14T10:00:00.000Z'))).toBe(false)

    const page = await readCatalogChanges(ctx.db, system, accountId, undefined)
    expect(page.changes).toHaveLength(1)
  })

  it('hands a consumer only its own store changes', async () => {
    await recordCatalogChanges(ctx.db, system, [
      change('product_updated', '700', '2026-06-14T10:00:00.000Z'),
      change('article_updated', '900', '2026-06-14T11:00:00.000Z', otherAccountId),
    ])

    const mine = await readCatalogChanges(ctx.db, system, accountId, undefined)
    expect(mine.changes.map((c) => c.entityId)).toEqual(['700'])
  })

  it('resumes where the consumer left off, and delivers nothing twice', async () => {
    await recordCatalogChanges(ctx.db, system, [
      change('product_updated', '700', '2026-06-14T10:00:00.000Z'),
      change('product_updated', '701', '2026-06-14T10:05:00.000Z'),
      change('article_updated', '900', '2026-06-14T10:10:00.000Z'),
    ])

    const first = await readCatalogChanges(ctx.db, system, accountId, undefined, 2)
    expect(first.changes.map((c) => c.entityId)).toHaveLength(2)

    const second = await readCatalogChanges(ctx.db, system, accountId, first.cursor)
    expect(second.changes).toHaveLength(1)

    const third = await readCatalogChanges(ctx.db, system, accountId, second.cursor)
    expect(third.changes).toEqual([])
  })

  it('separates the changes it produced from the deliveries still to process', async () => {
    await recordWebhookEvent(ctx.db, system, {
      webhookId: 'shopify-delivery-1',
      source: 'shopify',
      topic: 'products/update',
      payload: { id: 700 },
    })
    await recordCatalogChange(ctx.db, system, change('product_updated', '700', '2026-06-14T10:00:00.000Z'))

    const waiting = await unprocessedWebhooks(ctx.db, system)
    expect(waiting.map((row) => row.webhookId)).toEqual(['shopify-delivery-1'])
  })

  it('lets exactly one worker claim a delivery as done', async () => {
    await recordWebhookEvent(ctx.db, system, {
      webhookId: 'shopify-delivery-2',
      source: 'shopify',
      topic: 'products/update',
      payload: { id: 700 },
    })

    expect(await markWebhookProcessed(ctx.db, system, 'shopify-delivery-2', { status: 'processed' })).toBe(true)
    expect(await markWebhookProcessed(ctx.db, system, 'shopify-delivery-2', { status: 'processed' })).toBe(false)
    expect(await unprocessedWebhooks(ctx.db, system)).toEqual([])
  })
})

describe('database availability (catalogue suite)', () => {
  it('reports whether the catalogue tests actually ran', () => {
    if (!available) {
      throw new Error(
        'No Postgres at the test URL. The catalogue integration tests cannot be skipped silently — ' +
          'run `pnpm db:up` first.',
      )
    }
    expect(available).toBe(true)
  })
})

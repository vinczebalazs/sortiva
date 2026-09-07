import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  emptyFactSheet,
  familiesResponseSchema,
  productsResponseSchema,
  type FactSheet,
} from '@sortiva/core'
import {
  accountScope,
  makeProfileStore,
  productIdsByShopifyId,
  reconcileFamilies,
  upsertProductFacts,
  upsertProducts,
} from '@sortiva/db'
import { databaseAvailable, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { withAccount } from '../../auth/_lib/session'
import { makeGetFamiliesHandler, makeGetProductsHandler } from './handlers'

/**
 * The Products screen's two reads, driven end to end: the real session wrapper,
 * the real handlers, the real repositories, a real Postgres.
 *
 * The card these tests belong to exists because the screen appeared to work
 * while its server did not exist at all — the loader turns any failure into
 * "no data", so a 404 from a route nobody built renders as a store with an
 * empty catalogue. Mocking the fetch here would reproduce that exactly. So the
 * suite does two things instead: it proves the route *modules* are on disk at
 * the addresses the screen calls, and it proves the handlers tell an empty
 * store apart from a full one against real rows.
 */

// ── The addresses the screen actually calls ──────────────────────────────────

/**
 * The one assertion that would have caught the original defect. Not skipped
 * when Postgres is absent: a missing route file is not a database problem, and
 * this is the check that fails if either file is deleted, moved, or renamed.
 */
describe('the routes exist where the screen calls them', () => {
  it('serves GET /api/products', async () => {
    const route = await import('../route')
    expect(typeof route.GET).toBe('function')
    expect(route.dynamic).toBe('force-dynamic')
  })

  it('serves GET /api/products/families', async () => {
    const route = await import('../families/route')
    expect(typeof route.GET).toBe('function')
    expect(route.dynamic).toBe('force-dynamic')
  })
})

// ── The reads themselves ─────────────────────────────────────────────────────

const available = await databaseAvailable()

/** Six of the ten extractable fields stated: comfortably over the per-product floor. */
function richSheet(): FactSheet {
  return {
    ...emptyFactSheet(),
    material: 'mesh',
    dimensions: '30cm',
    weight: '280g',
    capacity: '1L',
    care: 'machine wash cold',
    origin: 'Portugal',
    fact_count: 6,
  }
}

/** One field stated. Below the floor, so this product is a merchant task. */
function thinSheet(): FactSheet {
  return { ...emptyFactSheet(), material: 'mesh', fact_count: 1 }
}

describe.skipIf(!available)('reading the Products screen', () => {
  let harness: TestDb
  let mine: string
  let theirs: string
  let familyId: string
  let thinProductId: string

  beforeAll(async () => {
    harness = await setupTestDb('web_products_read')
  })

  afterAll(async () => {
    await harness.close()
  })

  const seedProducts = async (accountId: string, batch: readonly { id: string; title: string; body: string | null }[]) => {
    const scope = accountScope(accountId)
    await upsertProducts(
      harness.db,
      scope,
      batch.map((product) => ({
        shopifyProductId: product.id,
        title: product.title,
        rawBodyHtml: product.body,
        productType: 'Shoes',
        tags: [],
        variants: [],
        priceRange: null,
        updatedAt: new Date('2026-09-01T00:00:00Z'),
        checksum: `sum-${product.id}`,
      })),
    )
    return productIdsByShopifyId(harness.db, scope, batch.map((product) => product.id))
  }

  const distil = async (accountId: string, productId: string, sheet: FactSheet) =>
    upsertProductFacts(harness.db, accountScope(accountId), {
      productId,
      factSheet: sheet,
      fluffDiscarded: true,
      promptVersion: 'distill.v1',
      modelId: 'test-model',
    })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    const { rows } = await harness.pool.query<{ id: string; email: string }>(
      "INSERT INTO accounts (email) VALUES ('mine@example.com'), ('theirs@example.com') RETURNING id, email",
    )
    mine = rows.find((row) => row.email === 'mine@example.com')!.id
    theirs = rows.find((row) => row.email === 'theirs@example.com')!.id

    await harness.pool.query(
      "INSERT INTO shopify_conns (account_id, shop_handle, access_token) VALUES ($1, 'trailhead-store', 'cipher')",
      [mine],
    )

    const ids = await seedProducts(mine, [
      { id: '2001', title: 'Trailhead 4', body: '<p>Premium quality mesh, perfect for any occasion</p>' },
      { id: '2002', title: 'Trailhead 4 Wide', body: '<p>Simply the finest</p>' },
      { id: '2003', title: 'Roadster 2', body: null },
    ])
    await distil(mine, ids.get('2001')!, richSheet())
    await distil(mine, ids.get('2002')!, thinSheet())
    // 2003 is deliberately left undistilled: nothing has read it yet.
    thinProductId = ids.get('2002')!

    await reconcileFamilies(
      harness.db,
      accountScope(mine),
      [
        {
          name: 'Trail Running Shoes',
          memberProductIds: [ids.get('2001')!, ids.get('2002')!],
          differentiationAxes: ['terrain', 'drop', 'width'],
          mergedFacts: {},
          groupingSource: 'collection',
          confidence: 'high',
        },
      ],
      new Map(),
    )
    const families = await harness.pool.query<{ id: string }>(
      'SELECT id FROM product_families WHERE account_id = $1',
      [mine],
    )
    familyId = families.rows[0]!.id

    const theirIds = await seedProducts(theirs, [
      { id: '9001', title: 'Secret Widget', body: '<p>Nobody else may see this</p>' },
    ])
    await distil(theirs, theirIds.get('9001')!, richSheet())
  })

  const openHold = async (accountId: string, keyword: string) => {
    const { rows } = await harness.pool.query<{ id: string }>(
      `INSERT INTO opportunities
         (account_id, signal_type, entity_type, entity_ref, evidence_json, impact, impact_score,
          confidence, reason_template_key, recommended_action, preconditions_json, status, rules_version)
       VALUES ($1, 'catalog_richness_gap', 'query_cluster', $2, '[]'::jsonb, 'high', 70,
               60, 'catalog_richness_gap.insufficient_substance', 'hold',
               '["catalog_richness_gap"]'::jsonb, 'blocked', 'test-rules')
       RETURNING id`,
      [accountId, keyword],
    )
    return rows[0]!.id
  }

  const products = (accountId: string | null) =>
    withAccount(
      makeGetProductsHandler({ db: harness.db, profile: makeProfileStore({ database: harness.db }) }),
      async () => accountId,
    )(new Request('http://localhost/api/products'), undefined)

  const familyList = (accountId: string | null) =>
    withAccount(
      makeGetFamiliesHandler({ db: harness.db, profile: makeProfileStore({ database: harness.db }) }),
      async () => accountId,
    )(new Request('http://localhost/api/products/families'), undefined)

  it('answers with the store the merchant actually has', async () => {
    const response = await products(mine)
    expect(response.status).toBe(200)
    const body = productsResponseSchema.parse(await response.json())

    expect(body.counts).toEqual({ products: 3, families: 1 })
    expect(body.products.map((row) => row.title)).toEqual([
      'Roadster 2',
      'Trailhead 4',
      'Trailhead 4 Wide',
    ])
    expect(body.products.every((row) => row.familyId === familyId || row.familyId === null)).toBe(true)
  })

  it('bites: the same read against a store with no products is not the same answer', async () => {
    const full = productsResponseSchema.parse(await (await products(mine)).json())
    await harness.pool.query('DELETE FROM products WHERE account_id = $1', [mine])
    await harness.pool.query('DELETE FROM product_families WHERE account_id = $1', [mine])

    const emptyResponse = await products(mine)
    // Still 200 and still a valid contract answer — an empty store is not an
    // error. What must differ is the content, which is exactly the difference
    // a missing route could not produce.
    expect(emptyResponse.status).toBe(200)
    const empty = productsResponseSchema.parse(await emptyResponse.json())

    expect(full.counts.products).toBe(3)
    expect(empty.counts).toEqual({ products: 0, families: 0 })
    expect(empty.products).toEqual([])
    expect(empty.richness).toEqual({ band: 'sparse', productsMissingDetails: 0 })
  })

  it('bands each product on what its own description supported', async () => {
    const body = productsResponseSchema.parse(await (await products(mine)).json())
    const byTitle = new Map(body.products.map((row) => [row.title, row]))

    expect(byTitle.get('Trailhead 4')!.richnessBand).toBe('rich')
    expect(byTitle.get('Trailhead 4')!.factCount).toBe(6)
    expect(byTitle.get('Trailhead 4')!.missingFields).not.toContain('material')

    expect(byTitle.get('Trailhead 4 Wide')!.richnessBand).toBe('sparse')
    expect(byTitle.get('Trailhead 4 Wide')!.missingFields).toContain('dimensions')

    // Never distilled: no facts, everything missing, and honestly sparse rather
    // than flattered with a band we have no evidence for.
    const unread = byTitle.get('Roadster 2')!
    expect(unread.factCount).toBe(0)
    expect(unread.richnessBand).toBe('sparse')
    expect(unread.missingFields).toHaveLength(10)
  })

  it('reports the store richness the distillation actually produced', async () => {
    const body = productsResponseSchema.parse(await (await products(mine)).json())
    // One product over the floor, one under: the band is read off the median,
    // and one thin product is what "missing key details" counts.
    expect(body.richness).toEqual({ band: 'sparse', productsMissingDetails: 1 })
  })

  it('turns an open HOLD into a task naming the products and what each is missing', async () => {
    const opportunityId = await openHold(mine, 'trail running shoes')
    const body = productsResponseSchema.parse(await (await products(mine)).json())

    expect(body.merchantTasks).toHaveLength(1)
    const task = body.merchantTasks[0]!
    expect(task.opportunityId).toBe(opportunityId)
    expect(task.blockingTitle).toBe('trail running shoes')
    expect(task.impact).toBe('high')
    expect(task.completedAt).toBeNull()

    expect(task.products).toHaveLength(1)
    expect(task.products[0]!.id).toBe(thinProductId)
    expect(task.products[0]!.title).toBe('Trailhead 4 Wide')
    expect(task.products[0]!.missingFields).toContain('dimensions')
    expect(task.products[0]!.shopifyAdminUrl).toBe(
      'https://admin.shopify.com/store/trailhead-store/products/2002',
    )
  })

  it('bites: filling in the product clears it from the task without waiting for a scan', async () => {
    await openHold(mine, 'trail running shoes')
    const before = productsResponseSchema.parse(await (await products(mine)).json())
    expect(before.merchantTasks[0]!.products).toHaveLength(1)

    await distil(mine, thinProductId, richSheet())

    const after = productsResponseSchema.parse(await (await products(mine)).json())
    expect(after.merchantTasks[0]!.products).toEqual([])
  })

  it('offers no admin link for a store we have no connection to', async () => {
    await harness.pool.query('DELETE FROM shopify_conns WHERE account_id = $1', [mine])
    await openHold(mine, 'trail running shoes')

    const body = productsResponseSchema.parse(await (await products(mine)).json())
    // Empty rather than a guessed address: the screen drops a link it cannot
    // recognise as Shopify admin and renders a plain row.
    expect(body.merchantTasks[0]!.products[0]!.shopifyAdminUrl).toBe('')
  })

  it("never lets the quarantined product description reach the response", async () => {
    await openHold(mine, 'trail running shoes')
    const raw = await (await products(mine)).text()
    expect(raw).not.toContain('Premium quality')
    expect(raw).not.toContain('Simply the finest')
  })

  it("never shows another merchant's catalogue", async () => {
    const raw = await (await products(mine)).text()
    expect(raw).not.toContain('Secret Widget')

    const theirBody = productsResponseSchema.parse(await (await products(theirs)).json())
    expect(theirBody.products.map((row) => row.title)).toEqual(['Secret Widget'])
    expect(theirBody.merchantTasks).toEqual([])
  })

  it('lists the families read-only, with their differentiation axes', async () => {
    const response = await familyList(mine)
    expect(response.status).toBe(200)
    const body = familiesResponseSchema.parse(await response.json())

    expect(body.families).toEqual([
      {
        id: familyId,
        label: 'Trail Running Shoes',
        memberCount: 2,
        axes: ['terrain', 'drop', 'width'],
        groupingSource: 'taxonomy',
        lowConfidence: false,
      },
    ])
  })

  it("does not answer another merchant's family list", async () => {
    const body = familiesResponseSchema.parse(await (await familyList(theirs)).json())
    expect(body.families).toEqual([])
  })

  it('refuses an unsigned-in caller on both reads', async () => {
    expect((await products(null)).status).toBe(401)
    expect((await familyList(null)).status).toBe(401)
  })
})

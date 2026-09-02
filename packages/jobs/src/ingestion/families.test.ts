import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { emptyFactSheet, type FactSheet, type StoreConnection } from '@sortiva/core'
import {
  accountScope,
  listFamilies,
  ungroupedProductCount,
  upsertProductFacts,
  upsertProducts,
} from '@sortiva/db'
import {
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { deriveIdempotencyKey } from '../runtime/idempotency'
import { runStep } from '../runtime/runStep'
import { createRun, findStep } from '../runtime/steps'
import type { ConnectionStore, IngestionDeps } from './deps'
import { familyGroupStep, type FamilyGroupOutput } from './families'

/**
 * Family grouping against a real database.
 *
 * The card's headline checks are here: forty shoes become a handful of
 * families, the axes come back as the merchant's own words, a product nobody
 * described stays on its own, and running the step twice does not produce two
 * sets of families — which is the property everything pointing at a family id
 * depends on.
 */

let harness: TestDb
let accountId: string

class FakeConnections implements ConnectionStore {
  async read(): Promise<StoreConnection | undefined> {
    return {
      accountId,
      shopHandle: 'acme',
      grantedScopes: ['read_products'],
      connectedAt: new Date('2026-09-01T09:00:00Z'),
      invalidatedAt: null,
    }
  }
  async readToken(): Promise<string | undefined> {
    return 'shpat_test'
  }
  async markInvalid(_accountId: string, at: Date): Promise<Date> {
    return at
  }
}

interface CapturedEvent {
  readonly event: string
  readonly properties?: Record<string, unknown>
}

function deps(captured: CapturedEvent[] = []): IngestionDeps {
  return {
    db: harness.db,
    pool: harness.pool,
    fetcher: {
      async fetch() {
        throw new Error('grouping makes no page fetches')
      },
    },
    shopify: {
      authorizeUrl: () => '',
      verifyCallbackSignature: () => true,
      exchangeCode: async () => ({ accessToken: '', grantedScopes: [] }),
    },
    shop: {
      async getShop() {
        throw new Error('not used')
      },
    },
    connections: new FakeConnections(),
    domains: {
      async findAccountByShopHandle() {
        return accountId
      },
      async setPlatform() {},
      async transition() {
        return undefined
      },
      async read() {
        return 'ingesting'
      },
      async readNormalized() {
        return 'acme.example'
      },
    },
    capture: {
      capture(event) {
        captured.push({ event: event.event, ...(event.properties ? { properties: event.properties } : {}) })
      },
    },
  }
}

interface SeedProduct {
  readonly shopifyId: string
  readonly title: string
  readonly productType?: string | null
  readonly tags?: readonly string[]
  readonly facts?: Partial<FactSheet>
  readonly checksum?: string
}

/**
 * Products written the way the catalogue sync writes them, and fact sheets
 * written the way distillation writes them — through the same repositories, so
 * the step reads what production would give it.
 */
async function seed(rows: readonly SeedProduct[]): Promise<void> {
  const scope = accountScope(accountId)
  await upsertProducts(
    harness.db,
    scope,
    rows.map((row) => ({
      shopifyProductId: row.shopifyId,
      title: row.title,
      rawBodyHtml: null,
      productType: row.productType ?? null,
      tags: [...(row.tags ?? [])],
      variants: [],
      priceRange: null,
      updatedAt: new Date('2026-06-14T10:00:00Z'),
      checksum: row.checksum ?? `c-${row.shopifyId}`,
    })),
    new Date('2026-06-14T10:00:00Z'),
  )

  const ids = await harness.pool.query<{ id: string; shopify_product_id: string }>(
    `select id, shopify_product_id from products where account_id = $1`,
    [accountId],
  )
  const byShopifyId = new Map(ids.rows.map((row) => [row.shopify_product_id, row.id]))

  for (const row of rows) {
    if (!row.facts) continue
    const sheet: FactSheet = { ...emptyFactSheet(), ...row.facts }
    await upsertProductFacts(harness.db, scope, {
      productId: byShopifyId.get(row.shopifyId)!,
      factSheet: sheet,
      fluffDiscarded: true,
      promptVersion: 'distill.v1',
      modelId: 'claude-haiku-test',
    })
  }
}

async function runGrouping(world: IngestionDeps): Promise<{
  status: string
  output: FamilyGroupOutput | undefined
}> {
  const run = await createRun(harness.db, accountId, `run-${Date.now()}-${Math.random()}`)
  await harness.pool.query(
    `update job_steps set state = 'succeeded'
     where job_id = $1 and step in ('detect','oauth_wait','catalog_sync','distill')`,
    [run.jobId],
  )
  const step = await findStep(harness.db, run.jobId, 'family_group')
  await harness.pool.query(`update job_steps set next_attempt_at = null where id = $1`, [step!.id])

  const outcome = await runStep({
    db: harness.db,
    pool: harness.pool,
    accountId,
    jobId: run.jobId,
    stepId: step!.id,
    idempotencyKey: deriveIdempotencyKey(
      accountId,
      'family_group',
      await familyGroupStep.inputVersion(world, accountId),
    ),
    handler: (ctx) => familyGroupStep.execute(world, ctx),
  })

  return { status: outcome.status, output: outcome.output as FamilyGroupOutput | undefined }
}

/** Forty shoes, described the way a merchant who tags their attributes describes them. */
function shoeCatalogue(): SeedProduct[] {
  const rows: SeedProduct[] = []
  const families = [
    {
      type: 'Trail Running Shoes',
      label: 'Trailhead',
      count: 12,
      axes: {
        terrain: ['technical', 'fire road', 'mixed'],
        drop: ['4mm', '6mm', '8mm'],
        width: ['standard', 'wide'],
      },
      facts: { material: 'engineered mesh', care: 'brush clean', origin: 'vietnam' },
    },
    {
      type: 'Road Running Shoes',
      label: 'Tempo',
      count: 10,
      axes: { cushioning: ['max', 'firm'], drop: ['6mm', '10mm'], width: ['standard', 'wide'] },
      facts: { material: 'engineered mesh', care: 'machine wash cold', origin: 'vietnam' },
    },
    {
      type: 'Hiking Boots',
      label: 'Ridgeline',
      count: 9,
      axes: {
        waterproofing: ['gore-tex', 'dwr'],
        ankle_height: ['mid', 'high'],
        width: ['standard', 'wide'],
      },
      facts: { material: 'full-grain leather', care: 'wax annually', origin: 'portugal' },
    },
    {
      type: 'Trail Apparel',
      label: 'Summit',
      count: 9,
      axes: { weather: ['wet', 'cold'], fit: ['relaxed', 'athletic'] },
      facts: { material: 'recycled ripstop nylon', care: 'machine wash cold', origin: 'portugal' },
    },
  ]

  let index = 0
  for (const family of families) {
    for (let member = 0; member < family.count; member += 1) {
      index += 1
      rows.push({
        shopifyId: String(index),
        title: `${family.label} ${member + 1}`,
        productType: family.type,
        tags: [
          ...Object.entries(family.axes).map(
            ([axis, values]) => `${axis}:${values[member % values.length]!}`,
          ),
          'ss26',
        ],
        facts: { ...family.facts, fact_count: 3 },
      })
    }
  }
  return rows
}

const available = await databaseAvailable()

describe.skipIf(!available)('turning a catalogue into families', () => {
  beforeAll(async () => {
    harness = await setupTestDb('families')
  }, 60_000)

  afterAll(async () => {
    await harness?.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    accountId = await insertAccount(harness.pool, `families-${Date.now()}@example.com`)
    await harness.pool.query(
      `insert into domains (account_id, domain_normalized, platform, state)
       values ($1, 'acme.example', 'shopify', 'ingesting')`,
      [accountId],
    )
  })

  it('turns forty shoes into four to six families, every product placed', async () => {
    await seed(shoeCatalogue())
    const { status, output } = await runGrouping(deps())

    expect(status).toBe('succeeded')
    expect(output?.productsGrouped).toBe(40)

    const families = await listFamilies(harness.db, accountScope(accountId))
    expect(families.length).toBeGreaterThanOrEqual(4)
    expect(families.length).toBeLessThanOrEqual(6)
    expect(await ungroupedProductCount(harness.db, accountScope(accountId))).toBe(0)
  })

  it("records the merchant's own words as the trail family's axes", async () => {
    await seed(shoeCatalogue())
    await runGrouping(deps())

    const families = await listFamilies(harness.db, accountScope(accountId))
    const trail = families.find((family) => family.name === 'Trail Running Shoes')
    expect(trail).toBeDefined()
    expect([...trail!.differentiationAxes].sort()).toEqual(['drop', 'terrain', 'width'])
    expect(trail!.memberCount).toBe(12)
  })

  it('records where every family came from and how far to trust it', async () => {
    await seed(shoeCatalogue())
    await runGrouping(deps())

    for (const family of await listFamilies(harness.db, accountScope(accountId))) {
      expect(family.groupingSource).toBe('collection')
      expect(family.confidence).toBe('high')
      expect(family.computedAt).toBeInstanceOf(Date)
    }
  })

  it('leaves a product nobody described on its own, however much it resembles a family', async () => {
    await seed([
      ...shoeCatalogue().slice(0, 12),
      // No product type, no tags, and a page that said one thing.
      { shopifyId: 'bare', title: 'Mystery Item', facts: { material: 'engineered mesh' } },
    ])
    await runGrouping(deps())

    const families = await listFamilies(harness.db, accountScope(accountId))
    const home = families.find((family) => family.name === 'Mystery Item')
    expect(home).toBeDefined()
    expect(home!.memberCount).toBe(1)
  })

  it('merges rows that are one product published in four colours', async () => {
    const facts = { material: 'engineered mesh', care: 'brush clean', origin: 'vietnam' }
    await seed(
      ['Red', 'Blue', 'Green', 'Black'].map((color, index) => ({
        shopifyId: `sv-${index}`,
        title: `Trailblazer Shoe — ${color}`,
        facts,
      })),
    )
    const { output } = await runGrouping(deps())

    expect(output?.logicalProductsMerged).toBe(1)
    const merged = await harness.pool.query<{ logical_product_id: string | null }>(
      `select logical_product_id from products where account_id = $1`,
      [accountId],
    )
    const ids = new Set(merged.rows.map((row) => row.logical_product_id))
    expect(ids.size).toBe(1)
    expect([...ids][0]).not.toBeNull()

    const families = await listFamilies(harness.db, accountScope(accountId))
    expect(families).toHaveLength(1)
    expect(families[0]?.groupingSource).toBe('split_variant')
    expect(families[0]?.differentiationAxes).toEqual(['color'])
  })

  it('returns the stored answer rather than regrouping an unchanged catalogue', async () => {
    await seed(shoeCatalogue())
    const first = await runGrouping(deps())
    expect(first.output?.familiesCreated).toBe(4)

    // Same inputs, same derived key: the ledger answers and nothing runs again.
    const second = await runGrouping(deps())
    expect(second.output).toEqual(first.output)
  })

  it('recomputes in place, so the ids other tables point at survive', async () => {
    await seed(shoeCatalogue())
    await runGrouping(deps())
    const before = await listFamilies(harness.db, accountScope(accountId))
    expect(before).toHaveLength(4)

    // A merchant edits one product's description. That is genuinely different
    // work, so the step runs again in full — and must not hand the store four
    // new families with four new ids while `products.family_id` and the page
    // inventory point at the old ones.
    await harness.pool.query(
      `update products set checksum = 'edited' where account_id = $1 and shopify_product_id = '1'`,
      [accountId],
    )
    const second = await runGrouping(deps())
    const after = await listFamilies(harness.db, accountScope(accountId))

    expect(second.output?.familiesCreated).toBe(0)
    expect(second.output?.familiesUpdated).toBe(before.length)
    expect(after.map((family) => family.id)).toEqual(before.map((family) => family.id))
  })

  it('drops a family whose products the merchant deleted, and reassigns the rest', async () => {
    await seed(shoeCatalogue())
    await runGrouping(deps())
    expect(await listFamilies(harness.db, accountScope(accountId))).toHaveLength(4)

    await harness.pool.query(
      `delete from products where account_id = $1 and product_type = 'Trail Apparel'`,
      [accountId],
    )
    const { output } = await runGrouping(deps())

    expect(output?.familiesRemoved).toBe(1)
    const names = (await listFamilies(harness.db, accountScope(accountId))).map(
      (family) => family.name,
    )
    expect(names).not.toContain('Trail Apparel')
    expect(names).toHaveLength(3)
  })

  it('reports the grouping as counts, and never as a merchant’s own words', async () => {
    const captured: CapturedEvent[] = []
    await seed(shoeCatalogue())
    await runGrouping(deps(captured))

    const event = captured.find((entry) => entry.event === 'family_grouping_completed')
    expect(event).toBeDefined()
    expect(event!.properties).toMatchObject({ products_grouped: 40, families: 4 })

    // Nothing in the event may be a product title, a family name or a tag.
    const serialised = JSON.stringify(event)
    for (const word of ['Trailhead', 'Trail Running Shoes', 'terrain', 'engineered mesh']) {
      expect(serialised).not.toContain(word)
    }
  })

  it('recognises finished work rather than regrouping an unchanged catalogue', async () => {
    await seed(shoeCatalogue())
    const world = deps()
    const first = await familyGroupStep.inputVersion(world, accountId)
    await runGrouping(world)
    expect(await familyGroupStep.inputVersion(world, accountId)).toBe(first)

    // A merchant re-filing one product is different work, and the key says so.
    await harness.pool.query(
      `update products set checksum = 'moved', product_type = 'Hiking Boots'
       where account_id = $1 and shopify_product_id = '1'`,
      [accountId],
    )
    expect(await familyGroupStep.inputVersion(world, accountId)).not.toBe(first)
  })
})

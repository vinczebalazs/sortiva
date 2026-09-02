import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  InMemoryRequestCache,
  emptyFactSheet,
  toProductRow,
  type FactSheet,
  type LlmRequest,
  type StoreConnection,
  type StorePage,
  type StorePageFetcher,
} from '@sortiva/core'
import {
  accountScope,
  readPersona,
  reconcileFamilies,
  replaceTopProducts,
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
import { MockLlmClient } from '@sortiva/llm'
import { deriveIdempotencyKey } from '../runtime/idempotency'
import { runStep } from '../runtime/runStep'
import { createRun, findStep } from '../runtime/steps'
import type { ConnectionStore, IngestionDeps, ShopSnapshot } from './deps'
import { personaStep, type PersonaStepOutput } from './persona'

/**
 * The persona against a real database, a real families table and the model
 * wrapper's own test double.
 *
 * The card's headline checks are here: the store's own settings beat the
 * model's guess about language and country, the publish clock comes from the
 * country rather than from the merchant's own timezone, the prompt is built
 * from families and never from a product's words, and a second run of finished
 * work costs nothing.
 */

let harness: TestDb
let accountId: string

const PROMPT = { version: 'persona.v1', text: 'describe the shop' }

const HOMEPAGE =
  '<!doctype html><html lang="sv-SE"><head>' +
  '<link rel="alternate" hreflang="sv-SE" href="https://acme.example/">' +
  '</head><body><h1>Acme Löparskor</h1><p>Vi säljer skor för terränglöpning.</p></body></html>'

const ABOUT = '<html lang="sv-SE"><body><p>Grundat 2011 i Göteborg.</p></body></html>'

/** The answer a model gives when it has read the brief and reached its own conclusions. */
function personaAnswer(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    business_description:
      'Acme säljer skor för terränglöpning till löpare på tekniskt underlag. Sortimentet spänner från lätta tävlingsskor till dämpade modeller för långa distanser.',
    product_categories: ['terrängskor'],
    main_language: 'en',
    country: 'US',
    audience: 'Ambitiösa terränglöpare',
    brand_tone: 'saklig',
    ...overrides,
  })
}

class FakeFetcher implements StorePageFetcher {
  readonly requested: string[] = []
  readonly answers = new Map<string, string>()

  serves(url: string, body: string): this {
    this.answers.set(url, body)
    return this
  }

  async fetch(request: { url: string }): Promise<StorePage> {
    this.requested.push(request.url)
    const body = this.answers.get(request.url)
    if (body === undefined) throw new Error(`no such page: ${request.url}`)
    return {
      finalUrl: request.url,
      status: 200,
      contentType: 'text/html',
      body,
      bytes: body.length,
      chain: [request.url],
      headers: {},
    }
  }
}

class FakeConnections implements ConnectionStore {
  invalid = false

  async read(): Promise<StoreConnection | undefined> {
    return {
      accountId,
      shopHandle: 'acme',
      grantedScopes: ['read_products', 'read_locales'],
      connectedAt: new Date('2026-09-01T09:00:00Z'),
      invalidatedAt: this.invalid ? new Date('2026-09-02T09:00:00Z') : null,
    }
  }
  async readToken(): Promise<string | undefined> {
    return 'shpat_test'
  }
  async markInvalid(_accountId: string, at: Date): Promise<Date> {
    return at
  }
}

interface World {
  readonly deps: IngestionDeps
  readonly llm: MockLlmClient
  readonly fetcher: FakeFetcher
  readonly connections: FakeConnections
  /** Every request that reached the wrapper, so the brief can be read back. */
  readonly requests: LlmRequest[]
}

function world(
  options: {
    shop?: Partial<ShopSnapshot> | 'unavailable'
    answer?: string
    cache?: InMemoryRequestCache
  } = {},
): World {
  const fetcher = new FakeFetcher()
    .serves('https://acme.example/', HOMEPAGE)
    .serves('https://acme.example/pages/about', ABOUT)

  const connections = new FakeConnections()
  const llm = new MockLlmClient({ cache: options.cache ?? new InMemoryRequestCache() })
  const requests: LlmRequest[] = []
  llm.setDefault('persona', (request) => {
    requests.push(request)
    return options.answer ?? personaAnswer()
  })

  const shopProfile: ShopSnapshot = {
    id: 42,
    name: 'Acme',
    myshopifyDomain: 'acme.myshopify.com',
    // The merchant runs the shop from Bali. It must not follow them there.
    ianaTimezone: 'Asia/Makassar',
    countryCode: 'SE',
    currency: 'SEK',
    primaryLocale: 'sv-SE',
    ...(options.shop === 'unavailable' ? {} : options.shop),
  }

  const deps: IngestionDeps = {
    db: harness.db,
    pool: harness.pool,
    fetcher,
    shopify: {
      authorizeUrl: () => '',
      verifyCallbackSignature: () => true,
      exchangeCode: async () => ({ accessToken: '', grantedScopes: [] }),
      revokeAccess: async () => {},
    },
    shop: {
      async getShop() {
        if (options.shop === 'unavailable') throw new Error('Shopify is having an hour')
        return shopProfile
      },
    },
    connections,
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
    llm,
    personaPrompt: PROMPT,
  }

  return { deps, llm, fetcher, connections, requests }
}

/**
 * A small grouped catalogue, written through the same repositories the earlier
 * steps write through: products, their fact sheets, their families and the
 * best-seller list. No description is written anywhere, and this file names no
 * column that could hold one.
 */
async function seedStore(): Promise<void> {
  const scope = accountScope(accountId)
  const rows = [
    { id: 'p1', title: 'Trailhead 3', material: 'mesh' },
    { id: 'p2', title: 'Trailhead 3 Wide', material: 'mesh' },
    { id: 'p3', title: 'Ridgeline Sock', material: 'merino' },
  ]

  await upsertProducts(
    harness.db,
    scope,
    rows.map((row) =>
      toProductRow({
        id: row.id,
        title: row.title,
        product_type: 'Trail Running Shoes',
        tags: '',
        updated_at: '2026-06-14T10:00:00Z',
      }),
    ),
    new Date('2026-06-14T10:00:00Z'),
  )

  const ids = await harness.pool.query<{ id: string; shopify_product_id: string }>(
    'select id, shopify_product_id from products where account_id = $1',
    [accountId],
  )
  const byShopifyId = new Map(ids.rows.map((row) => [row.shopify_product_id, row.id]))

  for (const row of rows) {
    const sheet: FactSheet = { ...emptyFactSheet(), material: row.material, fact_count: 1 }
    await upsertProductFacts(harness.db, scope, {
      productId: byShopifyId.get(row.id)!,
      factSheet: sheet,
      fluffDiscarded: true,
      promptVersion: 'distill.v1',
      modelId: 'claude-haiku-test',
    })
  }

  await reconcileFamilies(
    harness.db,
    scope,
    [
      {
        name: 'Trail Running Shoes',
        memberProductIds: [byShopifyId.get('p1')!, byShopifyId.get('p2')!],
        differentiationAxes: ['width'],
        mergedFacts: { ...emptyFactSheet(), material: 'mesh' },
        groupingSource: 'collection',
        confidence: 'high',
      },
      {
        name: 'Ridgeline Sock',
        memberProductIds: [byShopifyId.get('p3')!],
        differentiationAxes: [],
        mergedFacts: { ...emptyFactSheet(), material: 'merino' },
        groupingSource: 'collection',
        confidence: 'high',
      },
    ],
    new Map(),
  )

  await replaceTopProducts(harness.db, scope, [
    { productId: byShopifyId.get('p1')!, title: 'Trailhead 3', url: null, revenue90d: 900, qty90d: 30, rank: 1 },
  ])
}

async function runPersona(w: World): Promise<{
  status: string
  output: PersonaStepOutput | undefined
}> {
  const run = await createRun(harness.db, accountId, `run-${Date.now()}-${Math.random()}`)
  await harness.pool.query(
    `update job_steps set state = 'succeeded'
     where job_id = $1 and step in ('detect','oauth_wait','catalog_sync','distill','family_group')`,
    [run.jobId],
  )
  const step = await findStep(harness.db, run.jobId, 'persona')
  await harness.pool.query('update job_steps set next_attempt_at = null where id = $1', [step!.id])

  const outcome = await runStep({
    db: harness.db,
    pool: harness.pool,
    accountId,
    jobId: run.jobId,
    stepId: step!.id,
    idempotencyKey: deriveIdempotencyKey(
      accountId,
      'persona',
      await personaStep.inputVersion(w.deps, accountId),
    ),
    handler: (ctx) => personaStep.execute(w.deps, ctx),
  })

  return {
    status: outcome.status,
    output: 'output' in outcome ? (outcome.output as PersonaStepOutput) : undefined,
  }
}

async function storedTimezone(): Promise<string | undefined> {
  const { rows } = await harness.pool.query<{ timezone: string }>(
    'select timezone from account_settings where account_id = $1',
    [accountId],
  )
  return rows[0]?.timezone
}

describe.skipIf(!(await databaseAvailable()))('building a store’s business profile', () => {
  beforeAll(async () => {
    harness = await setupTestDb('persona')
  })

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    accountId = await insertAccount(harness.pool, 'persona@example.com')
    await harness.pool.query(
      `insert into domains (account_id, domain_normalized, platform, state)
       values ($1, 'acme.example', 'shopify', 'ingesting')`,
      [accountId],
    )
    await seedStore()
  })

  it('writes the profile, taking the store’s own settings over the model’s guess', async () => {
    const w = world()
    const { status, output } = await runPersona(w)

    expect(status).toBe('succeeded')
    // The model answered en/US. The shop's own Shopify settings say sv/SE.
    expect(output?.language).toBe('sv')
    expect(output?.country).toBe('SE')
    expect(output?.languageSource).toBe('shop_settings')
    expect(output?.countrySource).toBe('shop_settings')

    const stored = await readPersona(harness.db, accountScope(accountId))
    expect(stored?.language).toBe('sv')
    expect(stored?.country).toBe('SE')
    expect(stored?.productCategories).toEqual(['terrängskor'])
    expect(stored?.tone).toBe('saklig')
    expect(stored?.promptVersion).toBe('persona.v1')
    expect(stored?.modelId).toBe('claude-sonnet-5')
    // The number T2.3 computed and had nowhere to put: one fact on each of
    // three products.
    expect(stored?.richnessScore).toBe(1)
    expect(stored?.confirmedAt).toBeNull()
  })

  it('publishes on the audience’s clock, not the shop owner’s', async () => {
    const { output } = await runPersona(world())

    // Shopify says the shop is run from Asia/Makassar. The store sells into
    // Sweden, so nine in the morning means nine in Stockholm.
    expect(output?.timezone).toBe('Europe/Stockholm')
    expect(output?.timezoneSource).toBe('country_table')
    expect(await storedTimezone()).toBe('Europe/Stockholm')
  })

  it('never moves a timezone the merchant already has', async () => {
    await harness.pool.query(
      `insert into account_settings (account_id, timezone) values ($1, 'America/Denver')`,
      [accountId],
    )

    const { output } = await runPersona(world())

    expect(await storedTimezone()).toBe('America/Denver')
    expect(output?.timezone).toBe('America/Denver')
    expect(output?.timezoneKept).toBe(true)
  })

  it('describes the catalogue to the model as families and their axes', async () => {
    const w = world()
    await runPersona(w)

    const sent = w.requests[0]!.messages[0]!.content
    expect(sent).toContain('Trail Running Shoes (2 product(s))')
    expect(sent).toContain('members differ by: width')
    expect(sent).toContain('3 product(s), grouped into 2 product family/families')
    expect(sent).toContain('1. Trailhead 3')
    expect(sent).toContain('Grundat 2011 i Göteborg.')
    expect(sent).toContain('language: sv (from shop_settings)')
  })

  it('runs on the stronger tier and names no model of its own', async () => {
    const w = world()
    await runPersona(w)

    const request = w.requests[0]!
    expect(request.callType).toBe('persona')
    expect(request.model).toBeUndefined()
    expect(w.llm.calls[0]?.modelId).toBe('claude-sonnet-5')
  })

  it('carries on without the store’s own settings rather than stalling the merchant', async () => {
    const { status, output } = await runPersona(world({ shop: 'unavailable' }))

    expect(status).toBe('succeeded')
    // Shopify was unreachable, so the page's own markup answered instead.
    expect(output?.language).toBe('sv')
    expect(output?.languageSource).toBe('html_lang')
    expect(output?.country).toBe('SE')
    expect(output?.countrySource).toBe('html_lang_region')
  })

  it('carries on when the store has no about page', async () => {
    const w = world()
    w.fetcher.answers.delete('https://acme.example/pages/about')

    const { status, output } = await runPersona(w)

    expect(status).toBe('succeeded')
    expect(output?.pagesRead).toEqual(['homepage'])
    // Four addresses tried, none of them found, and none of them fatal.
    expect(w.fetcher.requested.filter((url) => url.includes('about')).length).toBeGreaterThan(0)
  })

  it('recognises finished work rather than paying for it twice', async () => {
    const cache = new InMemoryRequestCache()

    const first = world({ cache })
    await runPersona(first)
    expect(first.llm.calls).toHaveLength(1)

    // A redelivered dispatch of the same work, on a catalogue nobody touched.
    // The key is derived from the families, the best sellers and the size of
    // the catalogue, so it is the same key, and the ledger answers with the
    // stored profile without the step running at all.
    const second = world({ cache })
    const { status, output } = await runPersona(second)

    expect(status).toBe('succeeded')
    expect(output?.language).toBe('sv')
    expect(second.llm.calls).toHaveLength(0)
  })

  it('replays the model’s answer rather than re-sampling it after a crash', async () => {
    // The crash this exists for: the model answered, we were billed, and the
    // process died before the ledger recorded that the work was done. The
    // ledger cannot help on the retry — its row was never written — so the only
    // thing standing between that crash and a second bill is the request cache,
    // which the wrapper writes *before* it processes the answer.
    const cache = new InMemoryRequestCache()

    const first = world({ cache })
    await runPersona(first)
    await harness.pool.query('delete from idempotency_ledger')

    const second = world({ cache })
    const { status, output } = await runPersona(second)

    expect(status).toBe('succeeded')
    expect(output?.language).toBe('sv')
    // The step ran again and reached the model wrapper, which replayed the
    // stored completion: same answer, no second bill.
    expect(second.llm.calls).toHaveLength(1)
    expect(second.llm.calls[0]?.cacheHit).toBe(true)
    expect(second.llm.calls[0]?.usdCost).toBe(0)
    expect(second.llm.totalUsdCost).toBe(0)
  })

  it('refuses to run without its versioned prompt rather than inventing one', async () => {
    const w = world()
    const withoutPrompt: IngestionDeps = { ...w.deps }
    delete (withoutPrompt as { personaPrompt?: unknown }).personaPrompt

    const { status } = await runPersona({ ...w, deps: withoutPrompt })
    expect(status).toBe('dead_lettered')
  })
})

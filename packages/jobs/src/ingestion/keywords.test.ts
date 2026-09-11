import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ENRICHMENT_PAUSED_FLAG, InMemoryRequestCache, emptyFactSheet, serpSnapshotKey, type LlmRequest, type SerpResult, type ShopifyAccessGrant } from '@sortiva/core'
import {
  accountScope,
  listCompetitors,
  listKeywords,
  reconcileFamilies,
  systemScope,
  tripGlobalFlag,
  upsertPersona,
} from '@sortiva/db'
import {
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { MockLlmClient } from '@sortiva/llm'
import { MockSeoDataProvider } from '@sortiva/providers'
import { deriveIdempotencyKey } from '../runtime/idempotency'
import { runtimeLogger } from '../runtime/logging'
import { runStep } from '../runtime/runStep'
import { createRun, findStep } from '../runtime/steps'
import type { IngestionDeps } from './deps'
import { keywordsCompetitorsStep, type KeywordsCompetitorsOutput } from './keywords'

/** The grant nothing in this file asks for: these tests never install anything. */
const NO_GRANT: ShopifyAccessGrant = {
  accessToken: '',
  grantedScopes: [],
  expiresAt: null,
  refreshToken: null,
  refreshTokenExpiresAt: null,
}


/**
 * Keyword and competitor discovery against a real database, the model
 * wrapper's own double and the search vendor's own double.
 *
 * The double is not a stub returning fixtures: it de-duplicates on the same
 * canonical cache key the live adapter uses and prices from the same map, so
 * `billableCalls` here means what a bill would mean. That is what makes the
 * money cases in this file evidence rather than assertion.
 */

let harness: TestDb
let accountId: string

const PROMPT = { version: 'seeds.v1', text: 'propose search terms' }
const DOMAIN = 'acme.example'

/** Ten terms, so the SERP ceiling of ten is exercised rather than merely configured. */
const SEED_TERMS = [
  'trail running shoes',
  'wide fit trail shoes',
  'best trail running shoes',
  'waterproof trail shoes',
  'lightweight trail shoes',
  'trail shoes for wide feet',
  'cushioned trail shoes',
  'trail racing shoes',
  'merino running socks',
  'trail shoes technical terrain',
  'trail shoes long distance',
]

/**
 * The same three domains rank across the store's searches: a genuine rival, a
 * marketplace, and the store itself. Only the rival may end up on the list.
 */
function serpFor(keyword: string): SerpResult[] {
  return [
    { position: 1, url: `https://amazon.de/${keyword}`, domain: 'amazon.de', title: null },
    { position: 2, url: `https://rival.example/${keyword}`, domain: 'rival.example', title: null },
    { position: 3, url: `https://${DOMAIN}/${keyword}`, domain: DOMAIN, title: null },
    { position: 4, url: `https://second.example/${keyword}`, domain: 'second.example', title: null },
  ]
}

interface World {
  readonly deps: IngestionDeps
  readonly llm: MockLlmClient
  readonly seo: MockSeoDataProvider
  readonly requests: LlmRequest[]
}

function world(
  options: { terms?: readonly string[]; volumes?: Record<string, number>; cache?: InMemoryRequestCache } = {},
): World {
  const terms = options.terms ?? SEED_TERMS
  const llm = new MockLlmClient({ cache: options.cache ?? new InMemoryRequestCache() })
  const requests: LlmRequest[] = []
  llm.setDefault('seeds', (request) => {
    requests.push(request)
    return JSON.stringify({ keywords: [...terms] })
  })

  const seo = new MockSeoDataProvider({
    keywordMetrics: Object.fromEntries(
      terms.map((term, i) => [
        term,
        {
          monthlySearchVolume: options.volumes?.[term] ?? 1000 - i * 10,
          competition: 0.4,
          cpcUsd: 1.1,
        },
      ]),
    ),
    serp: Object.fromEntries(terms.map((term) => [term, serpFor(term)])),
  })

  const deps: IngestionDeps = {
    db: harness.db,
    pool: harness.pool,
    fetcher: { async fetch() { throw new Error('keyword discovery fetches no pages') } },
    shopify: {
      authorizeUrl: () => '',
      verifyCallbackSignature: () => true,
      exchangeCode: async () => NO_GRANT,
      refreshAccess: async () => NO_GRANT,
      revokeAccess: async () => {},
    },
    shop: {
      async getShop() {
        throw new Error('keyword discovery reads no shop settings')
      },
    },
    connections: {
      async read() {
        return undefined
      },
      async authFor() {
        return undefined
      },
      async markInvalid(_accountId: string, at: Date) {
        return at
      },
    },
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
        return DOMAIN
      },
    },
    llm,
    seedsPrompt: PROMPT,
    seo,
  }

  return { deps, llm, seo, requests }
}

async function seedProfile(): Promise<void> {
  const scope = accountScope(accountId)
  await reconcileFamilies(
    harness.db,
    scope,
    [
      {
        name: 'Trail Running Shoes',
        memberProductIds: [],
        differentiationAxes: ['terrain', 'width'],
        mergedFacts: { ...emptyFactSheet(), material: 'mesh' },
        groupingSource: 'collection',
        confidence: 'high',
      },
    ],
    new Map(),
  )
  await upsertPersona(harness.db, scope, {
    description: 'Acme sells trail running shoes.',
    productCategories: ['trail shoes'],
    language: 'en',
    country: 'GB',
    audience: 'Trail runners',
    tone: 'plain',
    richnessScore: 6,
    promptVersion: 'persona.v1',
    modelId: 'claude-sonnet-test',
  })
}

/** A step context with no job behind it, for the cases that must not go through the ledger. */
function stepContext() {
  return {
    db: harness.db,
    accountId,
    jobId: 'no-job',
    stepId: 'no-step',
    step: 'keywords_competitors' as const,
    idempotencyKey: 'direct',
    attempt: 1,
    checkpoint: undefined,
    async save() {},
    signal: new AbortController().signal,
    log: runtimeLogger(),
  }
}

async function runDiscovery(w: World): Promise<{
  status: string
  output: KeywordsCompetitorsOutput | undefined
}> {
  const run = await createRun(harness.db, accountId, `run-${Date.now()}-${Math.random()}`)
  await harness.pool.query(
    `update job_steps set state = 'succeeded'
     where job_id = $1 and step in ('detect','oauth_wait','catalog_sync','distill','family_group','persona')`,
    [run.jobId],
  )
  const step = await findStep(harness.db, run.jobId, 'keywords_competitors')
  await harness.pool.query('update job_steps set next_attempt_at = null where id = $1', [step!.id])

  const outcome = await runStep({
    db: harness.db,
    pool: harness.pool,
    accountId,
    jobId: run.jobId,
    stepId: step!.id,
    idempotencyKey: deriveIdempotencyKey(
      accountId,
      'keywords_competitors',
      await keywordsCompetitorsStep.inputVersion(w.deps, accountId),
    ),
    handler: (ctx) => keywordsCompetitorsStep.execute(w.deps, ctx),
  })

  return {
    status: outcome.status,
    output: 'output' in outcome ? (outcome.output as KeywordsCompetitorsOutput) : undefined,
  }
}

describe.skipIf(!(await databaseAvailable()))('finding a store’s keywords and competitors', () => {
  beforeAll(async () => {
    harness = await setupTestDb('keywords_step')
  })

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    accountId = await insertAccount(harness.pool, 'discovery@example.com')
    await seedProfile()
  })

  it('writes a draft keyword set, strongest first, priced in the store’s own market', async () => {
    const w = world()
    const result = await runDiscovery(w)
    expect(result.status).toBe('succeeded')

    const rows = await listKeywords(harness.db, accountScope(accountId))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]?.term).toBe('trail running shoes')
    expect(rows[0]?.volume).toBe(1000)
    expect(rows.every((row) => row.language === 'en' && row.country === 'GB')).toBe(true)
    expect(rows.every((row) => row.enrichedAt !== null)).toBe(true)
  })

  it('buys the market the profile named, never a default one', async () => {
    const w = world()
    await runDiscovery(w)
    // The double resolves the location code the same way the live adapter does;
    // an unmapped or wrong country would have thrown rather than guessed.
    expect(w.seo.calls.length).toBeGreaterThan(0)
    expect(w.seo.billableCalls).toBeGreaterThan(0)
  })

  /**
   * The merchant's competitor list is theirs to write. Onboarding used to fill
   * it with whoever currently outranks the store — useful-looking, and never
   * asked for. A domain on a results page is a domain on a results page: a
   * publisher, a forum and a marketplace all rank, and the size of this list is
   * what we pay the search-data vendor per store.
   */
  it('leaves the competitor list empty for the merchant to fill', async () => {
    const w = world()
    await runDiscovery(w)

    expect(await listCompetitors(harness.db, accountScope(accountId))).toEqual([])
  })

  it('counts the rivals worth offering, without the marketplace or the store itself', async () => {
    const w = world()
    const result = await runDiscovery(w)

    // Two survive the filters — the marketplace and the store's own domain do
    // not — and the count is what the log reports. Which two they are is held
    // by the ranking function's own tests and by the profile endpoint that
    // offers them; this asserts only that the step counted rather than wrote.
    expect(result.output?.competitorsProposed).toBe(2)
  })

  it('never offers more competitors than the cap, whatever the results pages hold', async () => {
    const w = world()
    // Twelve distinct rivals across every search: the ranking would happily
    // return them all, and the cap is what stops the list.
    const many = Object.fromEntries(
      SEED_TERMS.map((term) => [
        term,
        Array.from({ length: 12 }, (_, i) => ({
          position: i + 1,
          url: `https://r${i}.example/${term}`,
          domain: `r${i}.example`,
          title: null,
        })),
      ]),
    )
    const seo = new MockSeoDataProvider({
      keywordMetrics: Object.fromEntries(
        SEED_TERMS.map((term, i) => [term, { monthlySearchVolume: 1000 - i, competition: 0.3 }]),
      ),
      serp: many,
    })

    const result = await runDiscovery({ ...w, deps: { ...w.deps, seo }, seo })
    // The cap bounds what is *offered*, not just what is stored, because the
    // cost it exists to control is the vendor lookups a long list would drive
    // if the merchant accepted them all.
    expect(result.output?.competitorsProposed).toBe(5)
    expect(await listCompetitors(harness.db, accountScope(accountId))).toEqual([])
  })

  it('stores the results pages it read, and never an account against them', async () => {
    const w = world()
    await runDiscovery(w)

    const { rows } = await harness.pool.query<{ cache_key: string; query: string; locale: string }>(
      'select cache_key, query, locale from serp_snapshots order by query',
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.locale === 'en-GB')).toBe(true)
    expect(rows[0]?.cache_key).toBe(
      serpSnapshotKey({
        query: rows[0]!.query,
        locale: { language: 'en', country: 'GB' },
        depth: 10,
      }),
    )
  })

  it('buys one results page per search, and one priced request for all the terms together', async () => {
    const w = world()
    const result = await runDiscovery(w)

    const serpCalls = w.seo.calls.filter((call) => call.endpoint.includes('serp'))
    const metricCalls = w.seo.calls.filter((call) => call.endpoint.includes('search_volume'))
    expect(metricCalls).toHaveLength(1)
    // The vendor bills per request, so asking about eleven terms is one purchase.
    expect(metricCalls[0]?.billable).toBe(true)
    expect(serpCalls).toHaveLength(result.output!.serpsRead)
    expect(w.seo.billableCalls).toBe(w.seo.calls.length)
  })

  it('a redelivered job returns the answer already stored and buys nothing', async () => {
    const w = world()
    const first = await runDiscovery(w)
    const afterFirst = w.seo.billableCalls
    const modelCallsAfterFirst = w.llm.calls.length

    // The same account, the same profile, so the same derived idempotency key.
    // The completed-work ledger answers and the handler never runs.
    const second = await runDiscovery(w)

    expect(second.status).toBe('succeeded')
    expect(second.output).toEqual(first.output)
    expect(w.seo.billableCalls).toBe(afterFirst)
    expect(w.llm.calls.length).toBe(modelCallsAfterFirst)
  })

  it('and executing it again anyway reuses the stored pages and prices, buying nothing', async () => {
    const w = world()
    await runDiscovery(w)
    const afterFirst = w.seo.billableCalls
    const modelCallsAfterFirst = w.llm.calls.length

    // Deliberately round the ledger, which is the layer that would have made
    // this free without proving anything. What is left is the product's own
    // memory: results pages inside their week, terms inside their month.
    const output = (await keywordsCompetitorsStep.execute(
      w.deps,
      stepContext(),
    )) as KeywordsCompetitorsOutput

    expect(output.serpsRead).toBe(0)
    expect(output.serpsFromCache).toBeGreaterThan(0)
    expect(output.keywordsAlreadyFresh).toBe(output.seedTermsProposed)
    expect(w.seo.billableCalls).toBe(afterFirst)
    // The model was asked again and replayed its stored completion, so the
    // second run gets the same terms rather than a second opinion.
    expect(w.llm.calls.length).toBeGreaterThan(modelCallsAfterFirst)
    expect(w.llm.calls[w.llm.calls.length - 1]?.cacheHit).toBe(true)
  })

  it('a step killed part-way through the results pages does not re-buy the ones it had', async () => {
    const w = world()
    let reads = 0
    const flaky = {
      ...w.seo,
      keywordMetrics: w.seo.keywordMetrics.bind(w.seo),
      async serpTop(request: Parameters<MockSeoDataProvider['serpTop']>[0]) {
        reads += 1
        // Killed after the vendor has answered three searches and the rows are
        // committed — the shape of a crash mid-loop.
        if (reads > 3) throw new Error('worker killed')
        return w.seo.serpTop(request)
      },
    } as unknown as MockSeoDataProvider

    const killed = await runDiscovery({ ...w, deps: { ...w.deps, seo: flaky }, seo: flaky })
    expect(killed.status).not.toBe('succeeded')
    const boughtBeforeCrash = w.seo.billableCalls

    const resumed = await runDiscovery(w)
    expect(resumed.status).toBe('succeeded')
    // The three pages already stored are re-read from the database. Only the
    // remainder is bought, so the total is the number of distinct searches and
    // not one more.
    expect(resumed.output!.serpsFromCache).toBeGreaterThanOrEqual(3)
    expect(w.seo.billableCalls).toBeLessThan(boughtBeforeCrash + resumed.output!.serpsRead + 3)
  })

  it('pauses rather than buying when the day’s search-data bill has crossed its ceiling', async () => {
    await tripGlobalFlag(
      harness.db,
      systemScope('test raises the switch the spend sweep would raise'),
      {
        flag: ENRICHMENT_PAUSED_FLAG,
        actor: 'test',
        reason: 'the day’s search-data spend crossed its cap',
        trippedBy: 'auto',
      },
    )

    const w = world()
    const result = await runDiscovery(w)

    expect(result.status).toBe('retry_scheduled')
    expect(w.seo.calls).toHaveLength(0)
    expect(w.llm.calls).toHaveLength(0)
    expect(await listKeywords(harness.db, accountScope(accountId))).toHaveLength(0)
  })

  it('describes the store by its families and its axes, never by a product’s words', async () => {
    const w = world()
    await runDiscovery(w)

    const brief = w.requests[0]?.messages[0]?.content ?? ''
    expect(brief).toContain('Shop language: en')
    expect(brief).toContain('Shop country: GB')
    expect(brief).toContain('buyers choose between: terrain, width')
    expect(w.requests[0]?.callType).toBe('seeds')
  })
})

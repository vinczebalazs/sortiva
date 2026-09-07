import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  accountScope,
  appendSpendEvent,
  isAccountFlagActive,
  markStorePagesGoneNotSeenSince,
  markStorePagesSeen,
  upsertStorePages,
  type Db,
} from '@sortiva/db'
import {
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import {
  ACCOUNT_INTENT_GAP_PAUSED_FLAG,
  MODEL_CALLS_PER_PAID_ANALYSIS_MAX,
  silentLogger,
  type ClusterDefinition,
  type ClusterShareRow,
  type CoverageAnalysisOutput,
  type LlmClient,
  type LlmRequest,
  type LlmResult,
} from '@sortiva/core'
import { MockPageFetcher, MockSeoDataProvider } from '@sortiva/providers'
import { rules } from '@sortiva/rules'
import { evaluateAutoTrips } from '../sweeps/auto-trips'
import { mayAccountWorkRun } from '../runtime/gate'
import { analyseIntentGap } from './analyse'
import { scanIntentGaps } from './scan'

/**
 * Worked example 4 (main §7.8) against a real database: a collection at #11 for
 * "waterproof hiking boots" whose page settles none of what the pages above it
 * settle.
 *
 * Two of the three cases here are about *not* spending. A comparison of a page
 * nobody edited against a results page nobody re-bought must cost nothing at
 * all, and a store that has used up its allowance for the day must stop this
 * one thing and nothing else.
 */

const available = await databaseAvailable()

const BUDGETS = rules().defaults.budgets

/**
 * Enough paid model calls to put this store past its intent-gap allowance for the
 * day, which is what raises the flag these cases are about. More rows than
 * analyses because one analysis costs a second call when the first answer comes
 * back unreadable, and the brake leaves room for that.
 */
const PAST_THE_ALLOWANCE =
  BUDGETS.intent_gap.analyses_per_account_per_day * MODEL_CALLS_PER_PAID_ANALYSIS_MAX + 1
const NOW = new Date('2026-09-03T09:00:00.000Z')
const PAGE = 'https://shop.example/collections/hiking-boots'
const QUERY = 'waterproof hiking boots'
const LOCALE = { language: 'en', country: 'GB' }
const PROMPT = { version: 'intent-gap.v1', text: 'compare the pages' }

const RIVALS = [1, 2, 3, 4, 5].map((n) => ({
  position: n,
  url: `https://rival${n}.example/boots`,
  domain: `rival${n}.example`,
  title: `Best hiking boots ${n}`,
}))

const clusters: ClusterDefinition[] = [
  { headQuery: QUERY, memberQueries: [], clusterId: 'c-boots' },
]

const rows: ClusterShareRow[] = [
  { page: PAGE, query: QUERY, clicks: 88, impressions: 5200, position: 11 },
]

/** The example's answer: waterproofing, terrain, fit and sizing on the pages above; nothing on ours. */
function coverageAnswer(): CoverageAnalysisOutput {
  const covering = (count: number, heading: string) =>
    RIVALS.slice(0, count).map((r) => ({ url: r.url, heading }))
  return {
    subtopics: [
      { name: 'waterproofing', presentOnOurPage: false, ourEvidence: null, competitors: covering(5, 'Waterproofing') },
      { name: 'terrain', presentOnOurPage: false, ourEvidence: null, competitors: covering(4, 'Terrain') },
      { name: 'fit', presentOnOurPage: false, ourEvidence: null, competitors: covering(3, 'Fit') },
      { name: 'sizing', presentOnOurPage: false, ourEvidence: null, competitors: covering(3, 'Sizing') },
      { name: 'resoling', presentOnOurPage: false, ourEvidence: null, competitors: covering(1, 'Resoling') },
    ],
  }
}

/** Counts what a comparison would have cost, so a cache hit can be asserted as zero rather than merely fast. */
class CountingLlmClient implements LlmClient {
  readonly requests: LlmRequest[] = []
  constructor(private readonly answer: unknown) {}
  async complete<T>(request: LlmRequest): Promise<LlmResult<T>> {
    this.requests.push(request)
    return {
      output: this.answer as T,
      text: JSON.stringify(this.answer),
      modelId: 'claude-sonnet-5',
      promptVersion: request.promptVersion,
      cacheHit: false,
      usage: { inputTokens: 900, outputTokens: 600, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      usdCost: 0.008,
      latencyMs: 12,
      attempts: 1,
    }
  }
}

let harness: TestDb
let db: Db
let accountId: string

beforeAll(async () => {
  if (!available) {
    throw new Error('Postgres is not reachable. Run `pnpm db:up` before the test suite.')
  }
  harness = await setupTestDb('intent_gap')
  db = harness.db
}, 60_000)

afterAll(async () => {
  await harness?.close()
})

beforeEach(async () => {
  await truncateAll(harness.pool)
  accountId = await insertAccount(harness.pool, 'gap@example.com')
  await upsertStorePages(db, accountScope(accountId), [
    {
      url: PAGE,
      pageType: 'collection',
      handle: 'hiking-boots',
      shopifyId: 'gid://shopify/Collection/1',
      title: 'Hiking boots',
      seoTitle: 'Hiking boots',
      seoDescription: 'Our hiking boots',
      headings: ['Our range'],
      bodyHtml: '<p>Browse our hiking boots. Free delivery over £50.</p>',
      outboundInternalLinks: [],
      familyIds: [],
      checksum: 'checksum-v1',
    },
  ])
})

function fixtures() {
  const seo = new MockSeoDataProvider({ serp: { [QUERY]: RIVALS } })
  const pageFetcher = new MockPageFetcher()
  for (const rival of RIVALS) {
    pageFetcher.on(
      rival.url,
      `<h2>Waterproofing</h2><p>Gore-Tex keeps water out.</p><h2>Terrain</h2><p>Rock and mud.</p>`,
    )
  }
  const llm = new CountingLlmClient(coverageAnswer())
  return { seo, pageFetcher, llm }
}

function deps(f: ReturnType<typeof fixtures>) {
  return { db, ...f, prompt: PROMPT, now: () => NOW, logger: silentLogger }
}

describe.skipIf(!available)('worked example 4, end to end', () => {
  it('yields the gap set with per-subtopic evidence, on the page that exists', async () => {
    const f = fixtures()

    const result = await scanIntentGaps(deps(f), { accountId, clusters, rows, locale: LOCALE })

    expect(result.shortlisted).toBe(1)
    expect(result.analysed).toBe(1)
    expect(result.signals).toHaveLength(1)

    const signal = result.signals[0]!
    expect(signal.signalType).toBe('existing_page_intent_gap')
    expect(signal.page).toBe(PAGE)
    expect(signal.pageType).toBe('collection')
    expect(signal.position).toBe(11)
    // "resoling" is on one of the five, which is below the consensus floor.
    expect(signal.missingSubtopics).toEqual(['waterproofing', 'terrain', 'fit', 'sizing'])

    const byKey = new Map(signal.evidence.map((fact) => [fact.key, fact]))
    expect(byKey.get('missing_subtopic_1')?.value).toBe('waterproofing')
    expect(byKey.get('missing_subtopic_1_top_page_count')?.value).toBe(5)
    expect(String(byKey.get('missing_subtopic_1_top_page_headings')?.value)).toContain(
      'https://rival1.example/boots — Waterproofing',
    )
    expect(byKey.get('missing_subtopic_1')?.source).toBe('serp_coverage_analysis')
    expect(byKey.get('top_pages_analysed')?.value).toBe(5)

    expect(f.llm.requests).toHaveLength(1)
    expect(f.llm.requests[0]!.callType).toBe('intent_gap')
    expect(f.pageFetcher.callCount).toBe(5)
    expect(f.seo.billableCalls).toBe(1)
  })
})

describe.skipIf(!available)('an unchanged page compared against the same results page', () => {
  it('replays the answer and costs nothing: no vendor call, no page fetch, no model call', async () => {
    const f = fixtures()
    const input = { accountId, page: ourPage(), query: QUERY, locale: LOCALE }

    const first = await analyseIntentGap(deps(f), input)
    expect(first.status).toBe('analysed')
    const fetchesAfterFirst = f.pageFetcher.callCount
    const billableAfterFirst = f.seo.billableCalls

    const second = await analyseIntentGap(deps(f), input)

    expect(second.status).toBe('analysed')
    if (second.status !== 'analysed') return
    expect(second.analysis.cacheHit).toBe(true)
    expect(second.analysis.usdCost).toBe(0)
    // The same gap set, derived again from the stored answer.
    expect(second.analysis.subtopics.map((s) => s.name)).toEqual(
      first.status === 'analysed' ? first.analysis.subtopics.map((s) => s.name) : [],
    )

    expect(f.llm.requests).toHaveLength(1)
    expect(f.pageFetcher.callCount).toBe(fetchesAfterFirst)
    expect(f.seo.billableCalls).toBe(billableAfterFirst)
  })

  it('does the comparison again once the merchant edits the page', async () => {
    const f = fixtures()

    await analyseIntentGap(deps(f), { accountId, page: ourPage(), query: QUERY, locale: LOCALE })
    await analyseIntentGap(deps(f), {
      accountId,
      page: { ...ourPage(), checksum: 'checksum-v2' },
      query: QUERY,
      locale: LOCALE,
    })

    expect(f.llm.requests).toHaveLength(2)
  })
})

describe.skipIf(!available)('a store this call type has been paused for', () => {
  it('stops this call type and leaves the daily article alone', async () => {
    for (let i = 0; i < PAST_THE_ALLOWANCE; i += 1) {
      await appendSpendEvent(db, accountScope(accountId), {
        vendor: 'anthropic',
        callType: 'intent_gap',
        usdCost: 0.01,
        cacheHit: false,
        outcome: 'succeeded',
        occurredAt: NOW,
      })
    }
    await evaluateAutoTrips(db, { now: () => NOW, log: silentLogger })
    expect(await isAccountFlagActive(db, accountScope(accountId), ACCOUNT_INTENT_GAP_PAUSED_FLAG)).toBe(true)

    const f = fixtures()
    const outcome = await analyseIntentGap(deps(f), {
      accountId,
      page: ourPage(),
      query: QUERY,
      locale: LOCALE,
    })

    expect(outcome).toEqual({
      status: 'paused',
      reason: 'paused',
      flag: ACCOUNT_INTENT_GAP_PAUSED_FLAG,
    })
    // Nothing was bought on the way to refusing.
    expect(f.llm.requests).toHaveLength(0)
    expect(f.pageFetcher.callCount).toBe(0)
    expect(f.seo.billableCalls).toBe(0)

    // The content pipeline is untouched: the store's daily article still runs.
    expect(await mayAccountWorkRun(db, accountId, silentLogger)).toEqual({ allowed: true })
  })

  it('leaves the rest of the weekly shortlist for tomorrow rather than reporting a partial sweep as a clean one', async () => {
    for (let i = 0; i < PAST_THE_ALLOWANCE; i += 1) {
      await appendSpendEvent(db, accountScope(accountId), {
        vendor: 'anthropic',
        callType: 'intent_gap',
        usdCost: 0.01,
        cacheHit: false,
        outcome: 'succeeded',
        occurredAt: NOW,
      })
    }
    await evaluateAutoTrips(db, { now: () => NOW, log: silentLogger })

    const f = fixtures()
    const result = await scanIntentGaps(deps(f), { accountId, clusters, rows, locale: LOCALE })

    expect(result.pausedPartWay).toBe(true)
    expect(result.analysed).toBe(0)
    expect(result.signals).toEqual([])
  })
})

describe.skipIf(!available)('when we cannot see what the results page holds', () => {
  it('refuses rather than comparing against a results page we are not allowed to buy', async () => {
    const f = fixtures()

    const outcome = await analyseIntentGap(deps(f), {
      accountId,
      page: ourPage(),
      query: QUERY,
      locale: LOCALE,
      allowSerpSpend: false,
    })

    expect(outcome).toEqual({ status: 'unavailable', reason: 'no_fresh_serp' })
    expect(f.llm.requests).toHaveLength(0)
  })

  it('refuses rather than asking a model to compare against pages none of which loaded', async () => {
    const f = fixtures()
    f.pageFetcher.reset()

    const outcome = await analyseIntentGap(deps(f), {
      accountId,
      page: ourPage(),
      query: QUERY,
      locale: LOCALE,
    })

    expect(outcome).toEqual({ status: 'unavailable', reason: 'no_reachable_pages' })
    expect(f.llm.requests).toHaveLength(0)
  })
})

function ourPage() {
  return {
    url: PAGE,
    title: 'Hiking boots',
    headings: ['Our range'],
    excerpt: 'Browse our hiking boots.',
    checksum: 'checksum-v1',
  }
}

/**
 * The weekly comparison pass and a page the merchant has taken down.
 *
 * The pass buys a results page and a model call for every page it shortlists,
 * so a deleted page reaching the shortlist is money spent working out how to
 * improve something nobody can visit.
 */
describe.skipIf(!available)('a page the merchant has deleted', () => {
  it('is never shortlisted, so nothing is bought for it', async () => {
    const f = fixtures()
    const walk = new Date(Date.now() + 60_000)
    await markStorePagesGoneNotSeenSince(db, accountScope(accountId), walk)

    const result = await scanIntentGaps(deps(f), { accountId, clusters, rows, locale: LOCALE })

    expect(result.shortlisted).toBe(0)
    expect(result.analysed).toBe(0)
    expect(result.signals).toEqual([])
    expect(f.llm.requests, 'no model call for a page that is gone').toHaveLength(0)
    expect(f.seo.billableCalls, 'and no results page bought for it').toBe(0)
  })

  it('is shortlisted again once the walk finds it back in the store', async () => {
    const f = fixtures()
    const walk = new Date(Date.now() + 60_000)
    await markStorePagesGoneNotSeenSince(db, accountScope(accountId), walk)
    // Being served is what makes a page live again. The row kept its checksum
    // and its body throughout, so nothing else had to happen.
    await markStorePagesSeen(db, accountScope(accountId), [PAGE], new Date(walk.getTime() + 60_000))

    const result = await scanIntentGaps(deps(f), { accountId, clusters, rows, locale: LOCALE })

    expect(result.shortlisted).toBe(1)
    expect(result.analysed).toBe(1)
    expect(result.signals).toHaveLength(1)
  })
})

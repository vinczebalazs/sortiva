import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { serpSnapshotKey, silentLogger, type CoverageAnalysisOutput } from '@sortiva/core'
import { MockSeoDataProvider } from '@sortiva/providers/seo/mock'
import {
  accountScope,
  listOpenOpportunities,
  putBeforeProcessing,
  saveGscGrant,
  schema,
  selectGscProperty,
  systemScope,
  upsertGscQueryDaily,
  upsertSerpSnapshot,
  upsertStorePages,
  type GscQueryDailyInput,
} from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { rules } from '@sortiva/rules'
import { intentGapCacheKey } from '../optimize/analyse'
import { runSignalScan, type RunSignalScanDeps } from './run'

const available = await databaseAvailable()

/**
 * The free half of intent-gap detection, driven through the whole weekly scan
 * against real Postgres.
 *
 * What these cases are about is the seam between two jobs that never speak to
 * each other. A scheduled pass buys the page comparison on Sunday and files
 * the model's answer under an address it computes from what it saw; this scan
 * rebuilds that address on Monday from rows of its own and reads the answer, or
 * finds nothing and moves on. Neither half stores the address, so the only
 * proof that the join works is a test that plants what one side writes and asks
 * the other side to find it.
 */

const NOW = new Date('2026-09-07T07:00:00Z') // a Monday
const searchConsole = rules().defaults.search_console
const intentGap = rules().defaults.signals.existing_page_intent_gap

const PAGE = 'https://shop.example/collections/trail-shoes'
const PAGE_CHECKSUM = 'checksum-trail-v1'
const QUERY = 'trail running shoes'
/** No persona is seeded, so the scan falls back to the same market the paying pass does. */
const LOCALE = { language: 'en', country: 'US' }
const SERP_FETCHED_AT = new Date('2026-09-06T09:00:00Z') // the Sunday pass
const SERP_EXPIRES_AT = new Date('2026-09-13T09:00:00Z')

const system = systemScope('results pages are shared across stores; they carry no account')

function seo(): MockSeoDataProvider {
  return new MockSeoDataProvider({})
}

function deps(ctx: TestDb, provider: MockSeoDataProvider): RunSignalScanDeps {
  return {
    db: ctx.db,
    pool: ctx.pool,
    seo: provider,
    capture: { capture: () => undefined },
    now: () => NOW,
    logger: silentLogger,
  }
}

function dayInWindow(offset = 0): string {
  const date = new Date(NOW)
  date.setUTCDate(date.getUTCDate() - searchConsole.data_lag_days - offset)
  return date.toISOString().slice(0, 10)
}

function gscRow(over: Partial<GscQueryDailyInput> = {}): GscQueryDailyInput {
  return {
    date: dayInWindow(),
    page: PAGE,
    query: QUERY,
    device: 'DESKTOP',
    country: 'usa',
    clicks: 40,
    impressions: 900,
    position: 7, // inside the 4–20 band the shortlist reads
    ...over,
  }
}

const RANKING_PAGES = [1, 2, 3, 4, 5].map((position) => ({
  position,
  url: `https://rival${position}.example/trail-shoes`,
  domain: `rival${position}.example`,
  title: `Trail shoes ${position}`,
}))

/** The address the Sunday pass files its answer under, rebuilt from what it saw. */
function cacheKey(checksum = PAGE_CHECKSUM): string {
  return intentGapCacheKey({
    pageChecksum: checksum,
    serpCacheKey: serpSnapshotKey({ query: QUERY, locale: LOCALE, depth: intentGap.serp_top_n }),
    serpFetchedAt: SERP_FETCHED_AT,
  })
}

/** Two subtopics, each settled by three of the five pages above ours — the consensus floor exactly met. */
const GAP_ANSWER: CoverageAnalysisOutput = {
  subtopics: [
    {
      name: 'waterproofing',
      presentOnOurPage: false,
      ourEvidence: null,
      competitors: RANKING_PAGES.slice(0, 3).map((page) => ({ url: page.url, heading: 'Waterproofing' })),
    },
    {
      name: 'sizing for wide feet',
      presentOnOurPage: false,
      ourEvidence: null,
      competitors: RANKING_PAGES.slice(0, 3).map((page) => ({ url: page.url, heading: 'Fit and sizing' })),
    },
  ],
}

/** The same comparison, made again after the merchant covered both — nothing missing. */
const NO_GAP_ANSWER: CoverageAnalysisOutput = {
  subtopics: GAP_ANSWER.subtopics.map((subtopic) => ({
    ...subtopic,
    presentOnOurPage: true,
    ourEvidence: 'Now covered on the page',
  })),
}

describe.skipIf(!available)('the weekly scan reads the page comparison it did not pay for', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('scan-intent-gap')
    pool = ctx.pool
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    accountId = await insertAccount(pool, 'intent-gap-scan@example.com')
  })

  async function seedStore(options: { readonly gsc?: boolean } = {}): Promise<void> {
    const scope = accountScope(accountId)
    await upsertStorePages(ctx.db, scope, [
      {
        url: PAGE,
        pageType: 'collection',
        handle: 'trail-shoes',
        shopifyId: 'gid://shopify/Collection/1',
        title: 'Trail Running Shoes',
        seoTitle: 'Trail Running Shoes | Shop',
        seoDescription: 'Buy trail running shoes.',
        headings: ['Trail Running Shoes'],
        bodyHtml: '<p>Our trail shoes.</p>',
        outboundInternalLinks: [],
        familyIds: [],
        checksum: PAGE_CHECKSUM,
      },
    ])
    if (options.gsc === false) return
    await saveGscGrant(ctx.db, scope, { tokens: 'test-tokens' })
    await selectGscProperty(ctx.db, scope, { property: 'sc-domain:shop.example', connectedAt: NOW })
    await upsertGscQueryDaily(ctx.db, scope, [gscRow(), gscRow({ date: dayInWindow(1) })])
  }

  /** What the paying pass leaves behind: the results page it bought, and the model's raw answer filed against it. */
  async function seedSundayPass(answer: CoverageAnalysisOutput | null): Promise<void> {
    await upsertSerpSnapshot(ctx.db, system, {
      cacheKey: serpSnapshotKey({ query: QUERY, locale: LOCALE, depth: intentGap.serp_top_n }),
      query: QUERY,
      locale: 'en-US',
      results: RANKING_PAGES,
      fetchedAt: SERP_FETCHED_AT,
      expiresAt: SERP_EXPIRES_AT,
    })
    if (!answer) return
    await putBeforeProcessing(ctx.db, system, {
      cacheKey: cacheKey(),
      kind: 'llm',
      responseJson: answer,
      expiresAt: SERP_EXPIRES_AT,
    })
  }

  it('a shortlisted page with a stored comparison becomes an OPTIMIZE on the page that already exists', async () => {
    await seedStore()
    await seedSundayPass(GAP_ANSWER)
    const provider = seo()

    const outcome = await runSignalScan(deps(ctx, provider), accountId, 'weekly', 'weekly-2026-W37', {
      allowSerpSpend: false,
    })
    expect(outcome.status).toBe('completed')

    const open = await listOpenOpportunities(ctx.db, accountScope(accountId))
    const row = open.find((o) => o.signalType === 'existing_page_intent_gap')
    expect(row).toBeDefined()
    expect(row?.recommendedAction).toBe('optimize')
    expect(row?.entityType).toBe('url')
    expect(row?.entityRef).toBe(PAGE)

    // The evidence carries the merchant's own reasons to believe it: which
    // subtopics, on how many of the pages above, and that it is a reading of
    // other people's pages rather than a measurement.
    const evidence = row?.evidenceJson as { key: string; value: unknown; source: string }[]
    expect(evidence.find((f) => f.key === 'missing_subtopic_count')?.value).toBe(2)
    expect(evidence.find((f) => f.key === 'missing_subtopic_1')?.value).toBe('waterproofing')
    expect(evidence.find((f) => f.key === 'missing_subtopic_1_top_page_count')?.value).toBe(3)
    expect(evidence.find((f) => f.key === 'missing_subtopic_1')?.source).toBe('serp_coverage_analysis')

    // Nothing was bought to produce it — the comparison and the results page
    // were both already on hand.
    expect(provider.calls).toEqual([])
    expect(provider.billableCalls).toBe(0)
  })

  it('a shortlisted page with no stored comparison is passed over, and every other signal still lands', async () => {
    await seedStore()
    await seedSundayPass(null) // the results page is there; the comparison never happened

    const provider = seo()
    const outcome = await runSignalScan(deps(ctx, provider), accountId, 'weekly', 'weekly-2026-W37', {
      allowSerpSpend: false,
    })

    expect(outcome.status).toBe('completed')
    const open = await listOpenOpportunities(ctx.db, accountScope(accountId))
    expect(open.some((o) => o.signalType === 'existing_page_intent_gap')).toBe(false)
    // The rest of the pass is untouched by the missing comparison.
    expect(open.some((o) => o.signalType === 'striking_distance')).toBe(true)
    expect(provider.calls).toEqual([])
  })

  it('with no results page on hand either, the page is passed over and the scan still completes', async () => {
    await seedStore()

    const provider = seo()
    const outcome = await runSignalScan(deps(ctx, provider), accountId, 'weekly', 'weekly-2026-W37', {
      allowSerpSpend: false,
    })

    expect(outcome.status).toBe('completed')
    const open = await listOpenOpportunities(ctx.db, accountScope(accountId))
    expect(open.some((o) => o.signalType === 'existing_page_intent_gap')).toBe(false)
    expect(open.some((o) => o.signalType === 'striking_distance')).toBe(true)
    expect(provider.calls).toEqual([])
  })

  it('a comparison made against a version of the page the merchant has since edited is not replayed', async () => {
    await seedStore()
    await seedSundayPass(GAP_ANSWER)
    // The merchant edits the page: the fingerprint moves, so the address the
    // answer was filed under is no longer the address this scan computes.
    await upsertStorePages(ctx.db, accountScope(accountId), [
      {
        url: PAGE,
        pageType: 'collection',
        handle: 'trail-shoes',
        shopifyId: 'gid://shopify/Collection/1',
        title: 'Trail Running Shoes',
        seoTitle: 'Trail Running Shoes | Shop',
        seoDescription: 'Buy trail running shoes.',
        headings: ['Trail Running Shoes', 'Waterproofing'],
        bodyHtml: '<p>Our trail shoes, now waterproof.</p>',
        outboundInternalLinks: [],
        familyIds: [],
        checksum: 'checksum-trail-v2',
      },
    ])

    const provider = seo()
    await runSignalScan(deps(ctx, provider), accountId, 'weekly', 'weekly-2026-W37', { allowSerpSpend: false })

    const open = await listOpenOpportunities(ctx.db, accountScope(accountId))
    expect(open.some((o) => o.signalType === 'existing_page_intent_gap')).toBe(false)
    expect(provider.calls).toEqual([])
  })

  it('an opportunity survives a week with no comparison, and goes only when a comparison says the gap closed', async () => {
    await seedStore()
    await seedSundayPass(GAP_ANSWER)
    const scope = accountScope(accountId)

    await runSignalScan(deps(ctx, seo()), accountId, 'weekly', 'weekly-2026-W37', { allowSerpSpend: false })
    const detected = (await listOpenOpportunities(ctx.db, scope)).find(
      (o) => o.signalType === 'existing_page_intent_gap',
    )
    expect(detected).toBeDefined()

    // Week two: the pass never got to this page — its allowance ran out, say.
    // "We did not look" is not "the gap closed", so the row stays open.
    await ctx.db.delete(schema.requestCache)
    await runSignalScan(deps(ctx, seo()), accountId, 'weekly', 'weekly-2026-W38', { allowSerpSpend: false })
    const afterSilence = (await listOpenOpportunities(ctx.db, scope)).find((o) => o.id === detected!.id)
    expect(afterSilence?.status).toBe('new')

    // Week three: the comparison happened and reports nothing missing. That is
    // evidence, and the row expires on it.
    await putBeforeProcessing(ctx.db, system, {
      cacheKey: cacheKey(),
      kind: 'llm',
      responseJson: NO_GAP_ANSWER,
      expiresAt: SERP_EXPIRES_AT,
    })
    await runSignalScan(deps(ctx, seo()), accountId, 'weekly', 'weekly-2026-W39', { allowSerpSpend: false })
    const afterEvidence = await listOpenOpportunities(ctx.db, scope)
    expect(afterEvidence.some((o) => o.id === detected!.id)).toBe(false)
  })

  it('a store with no Search Console connection evaluates none of it, stored comparison or not', async () => {
    await seedStore({ gsc: false })
    await seedSundayPass(GAP_ANSWER)

    const provider = seo()
    const outcome = await runSignalScan(deps(ctx, provider), accountId, 'weekly', 'weekly-2026-W37', {
      allowSerpSpend: false,
    })

    expect(outcome.status).toBe('completed')
    const open = await listOpenOpportunities(ctx.db, accountScope(accountId))
    expect(open.some((o) => o.signalType === 'existing_page_intent_gap')).toBe(false)
    // Limited Intelligence still runs the catalogue-driven half of the engine.
    for (const row of open) expect(row.limitedIntelligence).toBe(true)
  })
})

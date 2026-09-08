import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { isCreateClearance, selectAction, type KeywordCandidate } from '@sortiva/core'
import { MockSeoDataProvider } from '@sortiva/providers/seo/mock'
import { accountScope, upsertStorePages, type StorePageInput } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { rules } from '@sortiva/rules'
import {
  assembleCompetitorGapInput,
  assembleExistingTargetCoverage,
  assembleFamilyCoverageInput,
} from './assemble'
import { detectCompetitorCoverageGaps, detectFamilyCoverageGaps, generateTasks } from '@sortiva/core'

const available = await databaseAvailable()

/**
 * The store's real rows, and whether a new page can be proposed over them.
 *
 * The rule is the one mistake with no visible symptom: two pages of the
 * merchant's own competing for one search look, from outside, exactly like one
 * page. So this asks the question the way the running scan asks it — off the
 * database, through the same assembly the weekly pass uses — rather than off a
 * hand-built answer, because a hand-built answer is exactly what used to make
 * these two findings look safe.
 */

const FAMILY = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-09-08T03:00:00Z')
const KEYWORD = 'walking boots'

function page(over: Partial<StorePageInput> = {}): StorePageInput {
  return {
    url: 'https://shop.example/collections/boots',
    pageType: 'collection',
    handle: 'boots',
    shopifyId: '1',
    title: 'Boots',
    seoTitle: 'Boots',
    seoDescription: 'Every boot we sell.',
    headings: [],
    bodyHtml: '<p>Boots.</p>',
    outboundInternalLinks: [],
    familyIds: [FAMILY],
    checksum: 'checksum-1',
    ...over,
  }
}

const RIVALS = [
  { domain: 'rival-one.com', position: 3, url: 'https://rival-one.com/a' },
  { domain: 'rival-two.com', position: 7, url: 'https://rival-two.com/b' },
]

const candidate: KeywordCandidate = {
  keyword: KEYWORD,
  monthlySearchVolume: 900,
  intentClass: 'buying_guide',
  familyIds: [FAMILY],
  source: 'merchant_seed',
}

describe.skipIf(!available)('nothing proposes a new page over a store page that is already there', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('create_clearance')
    pool = ctx.pool
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    accountId = await insertAccount(pool, 'create-clearance@example.com')
    await pool.query(
      `insert into product_families (id, account_id, name, member_count, grouping_source, confidence)
       values ($1, $2, 'Boots', 3, 'collection', 'high')`,
      [FAMILY, accountId],
    )
  })

  function deps() {
    return { db: ctx.db, seo: new MockSeoDataProvider(), rules: rules().defaults, now: () => NOW }
  }

  async function coverage() {
    return assembleExistingTargetCoverage(deps(), accountId, [candidate], [{ id: FAMILY, name: 'Boots' }])
  }

  /**
   * States what the page is for.
   *
   * The nightly walk records a page's address, its words and the ranges it
   * sells from, but nothing yet decides what a store page is *for* — so this
   * column is null on every real store today, and the check can only ever call
   * such a page a partial match. Set here so the difference between "we know
   * this page serves the subject" and "we do not know" is visible in the tests
   * rather than assumed.
   */
  async function statePagePurpose() {
    await pool.query(`update store_pages set intent_class = 'buying_guide' where account_id = $1`, [
      accountId,
    ])
  }

  it('hands the search a permission only the check can have issued', async () => {
    const { byKeyword } = await coverage()

    expect(isCreateClearance(byKeyword.get(KEYWORD)?.clearance)).toBe(true)
  })

  it('withholds that permission once the store has a page serving the same subject', async () => {
    await upsertStorePages(ctx.db, accountScope(accountId), [page({ familyIds: [FAMILY] })], NOW)
    const { byKeyword, byFamily } = await coverage()

    // The page has never been shown for anything — it holds no search position
    // at all — and it still counts. That is the whole point: a page nobody has
    // found is still the page this advice belongs to.
    expect(byKeyword.get(KEYWORD)?.url).toBe('https://shop.example/collections/boots')
    expect(byFamily.get(FAMILY)?.url).toBe('https://shop.example/collections/boots')

    // Partial while nothing has said what the page is for; the page takes the
    // work over outright once something has.
    expect(byKeyword.get(KEYWORD)?.strength).toBe('weak')
    await statePagePurpose()
    const stated = await coverage()
    expect(stated.byKeyword.get(KEYWORD)?.strength).toBe('strong')
    expect(stated.byKeyword.get(KEYWORD)?.clearance).toBeNull()
  })

  it('turns a competitor gap over an invisible page of ours into improving that page', async () => {
    await upsertStorePages(ctx.db, accountScope(accountId), [page()], NOW)
    const { byKeyword } = await coverage()

    const input = await assembleCompetitorGapInput(deps(), accountId, [candidate], false, byKeyword)
    const built = input.candidates[0]!

    expect(built.existingTarget.url).toBe('https://shop.example/collections/boots')

    // Two competitors ranking, nothing of ours in the search results — the
    // shape that used to mean "write a new one" and nothing else.
    const [signal] = detectCompetitorCoverageGaps({
      candidates: [{ ...built, competitorRankings: RIVALS, ourPosition: null, ourUrl: null }],
      config: rules().defaults.signals.competitor_coverage_gap,
      fetchedAt: NOW.toISOString(),
    })

    // Nothing has said what the collection page is for, so it is a partial
    // match: the article still goes ahead, and it now carries the job of
    // linking the two together instead of quietly competing with it.
    expect(selectAction(signal!).action).toBe('CREATE')
    expect(generateTasks(signal!).map((task) => task.kind)).toContain('internal_links')
  })

  it('improves the page instead, once something has said what that page is for', async () => {
    await upsertStorePages(ctx.db, accountScope(accountId), [page()], NOW)
    await statePagePurpose()
    const { byKeyword } = await coverage()

    const input = await assembleCompetitorGapInput(deps(), accountId, [candidate], false, byKeyword)
    const [signal] = detectCompetitorCoverageGaps({
      candidates: [{ ...input.candidates[0]!, competitorRankings: RIVALS, ourPosition: null, ourUrl: null }],
      config: rules().defaults.signals.competitor_coverage_gap,
      fetchedAt: NOW.toISOString(),
    })

    expect(signal!.ourRankingUrl).toBe('https://shop.example/collections/boots')
    expect(selectAction(signal!).action).toBe('OPTIMIZE')
  })

  it('stops proposing coverage for a range the store already has a page for', async () => {
    await upsertStorePages(ctx.db, accountScope(accountId), [page()], NOW)
    await statePagePurpose()
    const { byFamily } = await coverage()

    const input = await assembleFamilyCoverageInput(deps(), accountId, [candidate], byFamily)
    const signals = detectFamilyCoverageGaps({
      ...input,
      candidates: input.candidates.map((row) => ({
        ...row,
        // Everything else about the range says "write about this": it sells,
        // and searches map to it. The only thing standing between it and a new
        // article is the check.
        isTopSeller: true,
        revenueShare: 1,
        keywordCandidatesClearingFloor: 99,
        mappedContent: [],
      })),
    })

    expect(signals).toEqual([])
  })
})

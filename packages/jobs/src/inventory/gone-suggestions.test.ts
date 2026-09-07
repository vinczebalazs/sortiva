import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { silentLogger } from '@sortiva/core'
import { MockSeoDataProvider } from '@sortiva/providers/seo/mock'
import {
  accountScope,
  findOpportunityById,
  listOpenOpportunities,
  markStorePagesGoneNotSeenSince,
  markStorePagesSeen,
  transitionOpportunityStatus,
  upsertOpportunity,
  upsertStorePages,
  type OpportunityRow,
  type StorePageInput,
} from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { runSignalScan, type RunSignalScanDeps } from '../scan/run'
import { closeSuggestionsForGonePages } from './gone-suggestions'

const available = await databaseAvailable()

/**
 * What a merchant stops being asked about once they have deleted the page.
 *
 * The suggestion under test is a real one: the store is walked into the
 * inventory with a collection that has nothing written in its search fields,
 * and the detection pass makes the improve-this-page card out of that. Planting
 * the row by hand would prove the closing works and say nothing about whether
 * it ever meets a card a merchant would actually see.
 */

const T0 = new Date('2026-09-07T03:00:00Z')
/** The moment a later walk began — anything last seen before this went missing. */
const T1 = new Date('2026-09-08T03:00:00Z')

const GONE_PAGE = 'https://shop.example/collections/trail-shoes'
const KEPT_PAGE = 'https://shop.example/collections/road-shoes'

function page(over: Partial<StorePageInput> = {}): StorePageInput {
  return {
    url: GONE_PAGE,
    pageType: 'collection',
    handle: 'trail-shoes',
    shopifyId: '1',
    title: 'Trail Running Shoes',
    seoTitle: null,
    seoDescription: null,
    headings: [],
    bodyHtml: null,
    outboundInternalLinks: [],
    familyIds: [],
    checksum: 'a',
    ...over,
  }
}

describe.skipIf(!available)('the suggestions about a page the merchant deleted', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('gone-suggestions')
    pool = ctx.pool
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    accountId = await insertAccount(pool, 'gone-suggestions@example.com')
    await upsertStorePages(
      ctx.db,
      accountScope(accountId),
      [
        page(),
        page({
          url: KEPT_PAGE,
          handle: 'road-shoes',
          shopifyId: '2',
          title: 'Road Running Shoes',
          checksum: 'b',
        }),
      ],
      T0,
    )
  })

  function scanDeps(): RunSignalScanDeps {
    return {
      db: ctx.db,
      pool,
      seo: new MockSeoDataProvider({}),
      capture: { capture: () => undefined },
      now: () => T1,
      logger: silentLogger,
    }
  }

  function closeDeps() {
    return { db: ctx.db, now: () => T1, logger: silentLogger }
  }

  /** The detection pass, which is what makes a real suggestion out of a real page. */
  async function detect(runId: string): Promise<void> {
    const outcome = await runSignalScan(scanDeps(), accountId, 'weekly', runId)
    if (outcome.status !== 'completed') throw new Error(`the scan did not run: ${outcome.status}`)
  }

  /** The suggestion about the page this test deletes, whatever its status. */
  async function suggestionsFor(url: string): Promise<OpportunityRow[]> {
    const { rows } = await pool.query<OpportunityRow & { expired_reason: string | null }>(
      `select id, status, expired_reason, signal_type, entity_ref
         from opportunities
        where account_id = $1 and entity_ref = $2 and signal_type = 'missing_or_weak_metadata'`,
      [accountId, url],
    )
    return rows as unknown as OpportunityRow[]
  }

  /** Removes the page the way a walk that reached the end of the store does. */
  async function deleteThePage(): Promise<void> {
    await markStorePagesSeen(ctx.db, accountScope(accountId), [KEPT_PAGE], T1)
    await markStorePagesGoneNotSeenSince(ctx.db, accountScope(accountId), T1)
  }

  /** And puts it back, the way the next walk finding it does. */
  async function restoreThePage(): Promise<void> {
    await markStorePagesSeen(ctx.db, accountScope(accountId), [GONE_PAGE], T1)
  }

  it('stops offering it as work, and keeps the record that we ever suggested it', async () => {
    await detect('weekly-2026-W36')
    const before = await listOpenOpportunities(ctx.db, accountScope(accountId))
    const suggestion = before.find((row) => row.entityRef === GONE_PAGE)
    expect(suggestion).toBeDefined()

    await deleteThePage()
    expect(await closeSuggestionsForGonePages(closeDeps(), accountId)).toEqual({ closed: 1 })

    // Off the merchant's screen…
    const after = await listOpenOpportunities(ctx.db, accountScope(accountId))
    expect(after.map((row) => row.entityRef)).not.toContain(GONE_PAGE)

    // …but still there, stamped with why. Deleting it would throw away the only
    // record that we ever proposed this, which is what the learning loop reads.
    const closed = await findOpportunityById(ctx.db, accountScope(accountId), suggestion!.id)
    expect(closed?.status).toBe('expired')
    expect(closed?.expiredReason).toBe('entity_deleted')
  })

  it('leaves the suggestions about the pages the store still serves', async () => {
    await detect('weekly-2026-W36')
    await deleteThePage()

    await closeSuggestionsForGonePages(closeDeps(), accountId)

    const open = await listOpenOpportunities(ctx.db, accountScope(accountId))
    expect(open.map((row) => row.entityRef)).toContain(KEPT_PAGE)
  })

  it('closes nothing at all while every page is still served', async () => {
    await detect('weekly-2026-W36')
    const before = await listOpenOpportunities(ctx.db, accountScope(accountId))

    expect(await closeSuggestionsForGonePages(closeDeps(), accountId)).toEqual({ closed: 0 })

    const after = await listOpenOpportunities(ctx.db, accountScope(accountId))
    expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort())
  })

  it('runs again the next night without touching what it already closed', async () => {
    await detect('weekly-2026-W36')
    await deleteThePage()
    await closeSuggestionsForGonePages(closeDeps(), accountId)
    const closed = (await suggestionsFor(GONE_PAGE))[0]

    // The page is still gone, so this runs over the same store again. The row it
    // closed last night is no longer open, so there is nothing left to find.
    expect(await closeSuggestionsForGonePages(closeDeps(), accountId)).toEqual({ closed: 0 })

    const again = await suggestionsFor(GONE_PAGE)
    expect(again).toHaveLength(1)
    expect(again[0]?.id).toBe(closed?.id)
  })

  it('a page the merchant puts back gets its suggestion again, and only one', async () => {
    await detect('weekly-2026-W36')
    await deleteThePage()
    await closeSuggestionsForGonePages(closeDeps(), accountId)

    // Nothing is built to bring a suggestion back. The walk finds the page,
    // the row goes back to live, and the next detection pass proposes it again
    // by itself — the same as the improve-this-page button, which starts
    // working again with nothing run for it.
    await restoreThePage()
    await detect('weekly-2026-W37')

    const rows = await suggestionsFor(GONE_PAGE)
    // Two rows about this page and exactly one of them open: the closed one is
    // history, and the dedupe index cannot hold a second open row for the same
    // store, signal and page even if something tried to write one.
    expect(rows).toHaveLength(2)
    expect(rows.filter((row) => row.status === 'expired')).toHaveLength(1)
    const open = await listOpenOpportunities(ctx.db, accountScope(accountId))
    expect(open.filter((row) => row.entityRef === GONE_PAGE)).toHaveLength(1)
  })

  it('leaves a suggestion the calendar has already taken over', async () => {
    await detect('weekly-2026-W36')
    const suggestion = (await listOpenOpportunities(ctx.db, accountScope(accountId))).find(
      (row) => row.entityRef === GONE_PAGE,
    )!
    const scope = accountScope(accountId)
    await transitionOpportunityStatus(ctx.db, scope, suggestion.id, { from: ['new'], to: 'accepted' })
    await transitionOpportunityStatus(ctx.db, scope, suggestion.id, {
      from: ['accepted'],
      to: 'scheduled',
    })

    await deleteThePage()
    expect(await closeSuggestionsForGonePages(closeDeps(), accountId)).toEqual({ closed: 0 })

    // A row with a calendar day belongs to the machinery that put it there.
    // Expiring it from here would strand that work; it comes back into reach
    // when the calendar lets go of it.
    expect((await findOpportunityById(ctx.db, scope, suggestion.id))?.status).toBe('scheduled')
  })

  it('leaves alone the suggestions that are not about a page at all', async () => {
    const scope = accountScope(accountId)
    await upsertOpportunity(ctx.db, scope, {
      accountId,
      signalType: 'uncovered_commercial_query',
      entityType: 'query_cluster',
      // A search, not an address — and deliberately one spelled like the page
      // that is about to go, so a closing pass matching on the text alone
      // rather than on what the row is about would take this down too.
      entityRef: GONE_PAGE,
      evidence: [{ key: 'volume', value: '400', source: 'dataforseo', fetchedAt: T0.toISOString() }],
      confidence: 60,
      confidenceBand: 'medium',
      reasonTemplateKey: 'uncovered_commercial_query.create',
      reasonParams: {},
      recommendedAction: 'CREATE',
      preconditions: [],
      status: 'accepted',
      rulesVersion: 'test-rules-version',
      limitedIntelligence: false,
      detectedAt: T0.toISOString(),
      rawScore: 1,
      tasks: [],
      impactScore: 50,
      impact: 'medium',
    })

    await deleteThePage()
    await closeSuggestionsForGonePages(closeDeps(), accountId)

    const open = await listOpenOpportunities(ctx.db, scope)
    expect(open.find((row) => row.signalType === 'uncovered_commercial_query')?.status).toBe('accepted')
  })

  it('closes the one kind of suggestion the weekly pass deliberately never expires', async () => {
    const scope = accountScope(accountId)
    // The intent-gap card is made from a stored comparison of the page against
    // what is ranking. The weekly pass only expires one of these when it has a
    // fresh comparison to judge by, and a deleted page never gets compared
    // again — so without this, that card would sit on the screen for ever.
    await upsertOpportunity(ctx.db, scope, {
      accountId,
      signalType: 'existing_page_intent_gap',
      entityType: 'url',
      entityRef: GONE_PAGE,
      evidence: [{ key: 'missing_subtopics', value: '3', source: 'llm', fetchedAt: T0.toISOString() }],
      confidence: 60,
      confidenceBand: 'medium',
      reasonTemplateKey: 'existing_page_intent_gap.optimize',
      reasonParams: {},
      recommendedAction: 'OPTIMIZE',
      preconditions: [],
      status: 'new',
      rulesVersion: 'test-rules-version',
      limitedIntelligence: false,
      detectedAt: T0.toISOString(),
      rawScore: 1,
      tasks: [],
      impactScore: 50,
      impact: 'medium',
    })

    await deleteThePage()
    expect(await closeSuggestionsForGonePages(closeDeps(), accountId)).toEqual({ closed: 1 })

    const open = await listOpenOpportunities(ctx.db, scope)
    expect(open.some((row) => row.signalType === 'existing_page_intent_gap')).toBe(false)
  })
})

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { serpSnapshotKey, silentLogger, type CoverageAnalysisOutput } from '@sortiva/core'
import { MockSeoDataProvider } from '@sortiva/providers/seo/mock'
import {
  accountScope,
  listOpenOpportunities,
  markStorePagesGoneNotSeenSince,
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
 * What the weekly scan does with an open card whose evidence it can no longer
 * read — as against one whose evidence it read and found gone.
 *
 * The distinction is the whole point. "The measurement moved" is a conclusion
 * the merchant should see acted on. "We cannot see the measurement" is a broken
 * pipe on our side, and acting on it would take down a merchant's whole board
 * because their Google connection lapsed.
 */

const NOW = new Date('2026-09-07T07:00:00Z') // a Monday
const searchConsole = rules().defaults.search_console
const intentGap = rules().defaults.signals.existing_page_intent_gap

const PAGE = 'https://shop.example/collections/trail-shoes'
const PAGE_CHECKSUM = 'checksum-trail-v1'
const QUERY = 'trail running shoes'
const LOCALE = { language: 'en', country: 'US' }
const SERP_FETCHED_AT = new Date('2026-09-06T09:00:00Z')
const SERP_EXPIRES_AT = new Date('2026-09-13T09:00:00Z')

const system = systemScope('results pages are shared across stores; they carry no account')

function deps(ctx: TestDb): RunSignalScanDeps {
  return {
    db: ctx.db,
    pool: ctx.pool,
    seo: new MockSeoDataProvider({}),
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
    position: 7, // inside the 4–20 band both striking distance and the intent gap read
    ...over,
  }
}

const RANKING_PAGES = [1, 2, 3, 4, 5].map((position) => ({
  position,
  url: `https://rival${position}.example/trail-shoes`,
  domain: `rival${position}.example`,
  title: `Trail shoes ${position}`,
}))

function cacheKey(): string {
  return intentGapCacheKey({
    pageChecksum: PAGE_CHECKSUM,
    serpCacheKey: serpSnapshotKey({ query: QUERY, locale: LOCALE, depth: intentGap.serp_top_n }),
    serpFetchedAt: SERP_FETCHED_AT,
  })
}

const GAP_ANSWER: CoverageAnalysisOutput = {
  subtopics: ['waterproofing', 'sizing for wide feet'].map((name) => ({
    name,
    presentOnOurPage: false,
    ourEvidence: null,
    competitors: RANKING_PAGES.slice(0, 3).map((page) => ({ url: page.url, heading: name })),
  })),
}

describe.skipIf(!available)('what the weekly scan retires, and what it holds open', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('scan-expiry-gaps')
    pool = ctx.pool
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    accountId = await insertAccount(pool, 'expiry-gaps@example.com')
  })

  async function seedPage(): Promise<void> {
    await upsertStorePages(ctx.db, accountScope(accountId), [
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
    ],
    // The scan's own clock, not the wall clock, so that "the walk did not find
    // this page" below is a moment after the page was last seen. On the wall
    // clock it is a moment before, and the page stays live — which is how this
    // file's deleted-page test came to pass against an implementation that
    // never excluded a deleted page at all.
    NOW,
    )
  }

  async function connectSearchConsole(): Promise<void> {
    const scope = accountScope(accountId)
    await saveGscGrant(ctx.db, scope, { tokens: 'test-tokens' })
    await selectGscProperty(ctx.db, scope, { property: 'sc-domain:shop.example', connectedAt: NOW })
  }

  async function seedSundayPass(): Promise<void> {
    await upsertSerpSnapshot(ctx.db, system, {
      cacheKey: serpSnapshotKey({ query: QUERY, locale: LOCALE, depth: intentGap.serp_top_n }),
      query: QUERY,
      locale: 'en-US',
      results: RANKING_PAGES,
      fetchedAt: SERP_FETCHED_AT,
      expiresAt: SERP_EXPIRES_AT,
    })
    await putBeforeProcessing(ctx.db, system, {
      cacheKey: cacheKey(),
      kind: 'llm',
      responseJson: GAP_ANSWER,
      expiresAt: SERP_EXPIRES_AT,
    })
  }

  async function openRows(): Promise<Awaited<ReturnType<typeof listOpenOpportunities>>> {
    return listOpenOpportunities(ctx.db, accountScope(accountId))
  }

  describe('a store whose search data stopped arriving', () => {
    it('holds its search-driven cards open instead of retiring them all at once', async () => {
      await seedPage()
      await connectSearchConsole()
      await upsertGscQueryDaily(ctx.db, accountScope(accountId), [gscRow(), gscRow({ date: dayInWindow(1) })])

      await runSignalScan(deps(ctx), accountId, 'weekly', 'weekly-2026-W37', { allowSerpSpend: false })
      const detected = (await openRows()).find((row) => row.signalType === 'striking_distance')
      expect(detected).toBeDefined()

      // The sync stops: the grant is still on file, so this is not Limited
      // Intelligence — the store simply has no days left inside the window.
      await ctx.db.delete(schema.gscQueryDaily)
      await runSignalScan(deps(ctx), accountId, 'weekly', 'weekly-2026-W38', { allowSerpSpend: false })

      const after = (await openRows()).find((row) => row.id === detected!.id)
      expect(after?.status).toBe('new')
    })

    it('still retires a card when the data is there and the measurement has moved', async () => {
      await seedPage()
      await connectSearchConsole()
      await upsertGscQueryDaily(ctx.db, accountScope(accountId), [gscRow(), gscRow({ date: dayInWindow(1) })])

      await runSignalScan(deps(ctx), accountId, 'weekly', 'weekly-2026-W37', { allowSerpSpend: false })
      const detected = (await openRows()).find((row) => row.signalType === 'striking_distance')
      expect(detected).toBeDefined()

      // The page climbs to second place. Same days, same rows, a different
      // number in them — which is evidence, and the row goes on it.
      await upsertGscQueryDaily(ctx.db, accountScope(accountId), [
        gscRow({ position: 2 }),
        gscRow({ date: dayInWindow(1), position: 2 }),
      ])
      await runSignalScan(deps(ctx), accountId, 'weekly', 'weekly-2026-W38', { allowSerpSpend: false })

      expect((await openRows()).some((row) => row.id === detected!.id)).toBe(false)
    })

    it('holds its search-driven cards open when the merchant disconnects Search Console', async () => {
      await seedPage()
      await connectSearchConsole()
      await upsertGscQueryDaily(ctx.db, accountScope(accountId), [gscRow(), gscRow({ date: dayInWindow(1) })])

      await runSignalScan(deps(ctx), accountId, 'weekly', 'weekly-2026-W37', { allowSerpSpend: false })
      const detected = (await openRows()).find((row) => row.signalType === 'striking_distance')
      expect(detected).toBeDefined()

      // Limited Intelligence from here on. §7.11 promises that reconnecting
      // re-scores the existing opportunities, which needs them to still exist.
      await ctx.db.delete(schema.gscConns)
      await runSignalScan(deps(ctx), accountId, 'weekly', 'weekly-2026-W38', { allowSerpSpend: false })

      const after = (await openRows()).find((row) => row.id === detected!.id)
      expect(after?.status).toBe('new')
    })
  })

  describe('an intent-gap card for a page that has left the band', () => {
    it('is retired without anyone buying a second comparison', async () => {
      await seedPage()
      await connectSearchConsole()
      await upsertGscQueryDaily(ctx.db, accountScope(accountId), [gscRow(), gscRow({ date: dayInWindow(1) })])
      await seedSundayPass()

      await runSignalScan(deps(ctx), accountId, 'weekly', 'weekly-2026-W37', { allowSerpSpend: false })
      const detected = (await openRows()).find((row) => row.signalType === 'existing_page_intent_gap')
      expect(detected).toBeDefined()

      // The page climbs above the band. No new comparison is bought, and none
      // ever would be — the paying pass shortlists inside the band only, so
      // waiting for one would keep this card up for ever.
      await upsertGscQueryDaily(ctx.db, accountScope(accountId), [
        gscRow({ position: 2 }),
        gscRow({ date: dayInWindow(1), position: 2 }),
      ])
      await ctx.db.delete(schema.requestCache)

      const provider = new MockSeoDataProvider({})
      await runSignalScan({ ...deps(ctx), seo: provider }, accountId, 'weekly', 'weekly-2026-W38', {
        allowSerpSpend: false,
      })

      expect((await openRows()).some((row) => row.id === detected!.id)).toBe(false)
      expect(provider.billableCalls).toBe(0)
    })

    it('is left alone when the page left the store rather than the band', async () => {
      await seedPage()
      await connectSearchConsole()
      await upsertGscQueryDaily(ctx.db, accountScope(accountId), [gscRow(), gscRow({ date: dayInWindow(1) })])
      await seedSundayPass()

      await runSignalScan(deps(ctx), accountId, 'weekly', 'weekly-2026-W37', { allowSerpSpend: false })
      const detected = (await openRows()).find((row) => row.signalType === 'existing_page_intent_gap')
      expect(detected).toBeDefined()

      // The merchant deletes the page. The nightly walk closes this one, under
      // the reason that says the subject was taken away — a different thing
      // from a measurement moving, and the learning loop reads the two
      // differently. This pass must not get there first with the wrong reason.
      const marked = await markStorePagesGoneNotSeenSince(
        ctx.db,
        accountScope(accountId),
        new Date(NOW.getTime() + 60_000),
      )
      expect(marked).toBe(1)
      await ctx.db.delete(schema.requestCache)
      await runSignalScan(deps(ctx), accountId, 'weekly', 'weekly-2026-W38', { allowSerpSpend: false })

      const after = (await openRows()).find((row) => row.id === detected!.id)
      expect(after?.status).toBe('new')
    })
  })
})

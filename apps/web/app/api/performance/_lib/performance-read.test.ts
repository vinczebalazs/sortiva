import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { performanceOverviewResponseSchema, searchConsoleResponseSchema } from '@sortiva/core'
import { makePerformanceStore } from '@sortiva/db'
import { databaseAvailable, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { withAccount } from '../../auth/_lib/session'
import { makePerformanceOverviewHandler, makeSearchConsoleHandler } from './handlers'

/**
 * Both Performance reads, driven end to end: the real session wrapper, the real
 * handlers, the real repositories, a real Postgres.
 *
 * The card these belong to exists because three finished screens read three
 * endpoints that were never built, and the loader behind every screen turns any
 * failure into "no data" — so a 404 rendered exactly like a store with nothing
 * to show. A test that mocked the fetch would reproduce that defect rather than
 * catch it. So this suite proves the route modules are on disk at the addresses
 * the screens call, and proves the handlers tell a store with search data apart
 * from one without against real rows.
 */

// ── The addresses the screens actually call ─────────────────────────────────

/**
 * The assertion that would have caught the original defect. Deliberately not
 * skipped when Postgres is absent: a missing route file is not a database
 * problem, and this is what fails if either file is deleted, moved or renamed.
 */
describe('the routes exist where the screens call them', () => {
  it('serves GET /api/performance/overview', async () => {
    const route = await import('../overview/route')
    expect(typeof route.GET).toBe('function')
    expect(route.dynamic).toBe('force-dynamic')
  })

  it('serves GET /api/performance/search-console', async () => {
    const route = await import('../search-console/route')
    expect(typeof route.GET).toBe('function')
    expect(route.dynamic).toBe('force-dynamic')
  })
})

// ── The reads themselves ────────────────────────────────────────────────────

const available = await databaseAvailable()

const CONNECTED_ON = '2026-08-01'
/** The last day the fixture store has any search data for; every window ends here. */
const LAST_DAY = '2026-09-03'
/** Inside the window and deliberately left without a row, so the chart has a gap to draw. */
const MISSING_DAY = '2026-09-01'

describe.skipIf(!available)('reading the Performance screens', () => {
  let harness: TestDb
  let mine: string
  let theirs: string
  let articleId: string
  let opportunityId: string

  beforeAll(async () => {
    harness = await setupTestDb('web_performance_read')
  })

  afterAll(async () => {
    await harness.close()
  })

  const seedDaily = async (
    accountId: string,
    rows: readonly { date: string; page: string; clicks: number; impressions: number; position: number }[],
  ) => {
    for (const row of rows) {
      await harness.pool.query(
        `INSERT INTO gsc_daily (account_id, date, page, clicks, impressions, position)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [accountId, row.date, row.page, row.clicks, row.impressions, row.position],
      )
    }
  }

  const seedQueryDaily = async (
    accountId: string,
    rows: readonly { date: string; page: string; query: string; clicks: number; impressions: number; position: number }[],
  ) => {
    for (const row of rows) {
      await harness.pool.query(
        `INSERT INTO gsc_query_daily (account_id, date, page, query, device, country, clicks, impressions, position)
         VALUES ($1, $2, $3, $4, 'desktop', 'gb', $5, $6, $7)`,
        [accountId, row.date, row.page, row.query, row.clicks, row.impressions, row.position],
      )
    }
  }

  beforeEach(async () => {
    await truncateAll(harness.pool)
    const { rows } = await harness.pool.query<{ id: string; email: string }>(
      "INSERT INTO accounts (email) VALUES ('mine@example.com'), ('theirs@example.com') RETURNING id, email",
    )
    mine = rows.find((row) => row.email === 'mine@example.com')!.id
    theirs = rows.find((row) => row.email === 'theirs@example.com')!.id

    for (const accountId of [mine, theirs]) {
      await harness.pool.query(
        `INSERT INTO gsc_conns (account_id, property, tokens, connected_at)
         VALUES ($1, 'sc-domain:example.com', 'cipher', $2)`,
        [accountId, `${CONNECTED_ON}T00:00:00Z`],
      )
    }

    // Two days of store-wide totals with a gap between them, and one page that
    // improved between the earlier window and the later one.
    await seedDaily(mine, [
      { date: '2026-08-02', page: 'https://example.com/collections/trail', clicks: 10, impressions: 400, position: 12 },
      { date: '2026-08-30', page: 'https://example.com/collections/trail', clicks: 40, impressions: 900, position: 8 },
      { date: LAST_DAY, page: 'https://example.com/collections/trail', clicks: 55, impressions: 1000, position: 6 },
      { date: LAST_DAY, page: 'https://example.com/blogs/journal/wide-fit', clicks: 7, impressions: 120, position: 14 },
    ])
    await seedQueryDaily(mine, [
      { date: '2026-08-02', page: 'https://example.com/collections/trail', query: 'wide trail shoes', clicks: 5, impressions: 200, position: 13 },
      { date: LAST_DAY, page: 'https://example.com/collections/trail', query: 'wide trail shoes', clicks: 30, impressions: 700, position: 6 },
    ])

    await seedDaily(theirs, [
      { date: LAST_DAY, page: 'https://elsewhere.example/secret', clicks: 999, impressions: 9999, position: 1 },
    ])

    await harness.pool.query(
      `INSERT INTO store_pages (account_id, url, page_type, title)
       VALUES ($1, 'https://example.com/collections/trail', 'collection', 'Trail running shoes')`,
      [mine],
    )

    const source = await harness.pool.query<{ id: string }>(
      `INSERT INTO opportunities
         (account_id, signal_type, entity_type, entity_ref, evidence_json, impact, impact_score,
          confidence, reason_template_key, recommended_action, status, rules_version)
       VALUES ($1, 'uncovered_commercial_query', 'query_cluster', 'wide trail shoes', '[]'::jsonb,
               'high', 90, 75, 'uncovered_commercial_query.no_page_covers_it', 'create', 'completed',
               'test-rules')
       RETURNING id`,
      [mine],
    )
    const topic = await harness.pool.query<{ id: string }>(
      `INSERT INTO topics (account_id, opportunity_id, title, target_keyword, intent_class, source, scheduled_date, state)
       VALUES ($1, $2, 'Wide fit trail shoes', 'wide trail shoes', 'buying_guide', 'auto', '2026-08-30', 'published')
       RETURNING id`,
      [mine, source.rows[0]!.id],
    )
    const article = await harness.pool.query<{ id: string }>(
      `INSERT INTO articles (account_id, topic_id, title, slug, state, published_url, published_at)
       VALUES ($1, $2, 'Wide fit trail shoes', 'wide-fit-trail-shoes', 'published',
               'https://example.com/blogs/journal/wide-fit', '2026-08-30T09:00:00Z')
       RETURNING id`,
      [mine, topic.rows[0]!.id],
    )
    articleId = article.rows[0]!.id

    // An improvement the merchant said they carried out, on the collection.
    const applied = await harness.pool.query<{ id: string }>(
      `INSERT INTO opportunities
         (account_id, signal_type, entity_type, entity_ref, evidence_json, impact, impact_score,
          confidence, reason_template_key, recommended_action, status, rules_version, applied_at)
       VALUES ($1, 'striking_distance', 'url', 'https://example.com/collections/trail', '[]'::jsonb,
               'high', 80, 70, 'striking_distance.page_one_reachable', 'optimize', 'completed',
               'test-rules', '2026-08-30T12:00:00Z')
       RETURNING id`,
      [mine],
    )
    opportunityId = applied.rows[0]!.id
  })

  const overview = (accountId: string | null) =>
    withAccount(
      makePerformanceOverviewHandler({ store: makePerformanceStore({ database: harness.db }) }),
      async () => accountId,
    )(new Request('http://localhost/api/performance/overview'), undefined)

  const searchConsole = (accountId: string | null, query: string) =>
    withAccount(
      makeSearchConsoleHandler({ store: makePerformanceStore({ database: harness.db }) }),
      async () => accountId,
    )(new Request(`http://localhost/api/performance/search-console?${query}`), undefined)

  it('draws the store’s own search data from the day it connected', async () => {
    const response = await overview(mine)
    expect(response.status).toBe(200)
    const body = performanceOverviewResponseSchema.parse(await response.json())

    expect(body.connected).toBe(true)
    expect(body.series[0]!.date).toBe(CONNECTED_ON)
    expect(body.series.at(-1)!.date).toBe(LAST_DAY)

    const byDate = new Map(body.series.map((point) => [point.date, point]))
    expect(byDate.get('2026-08-02')).toEqual({ date: '2026-08-02', clicks: 10, impressions: 400 })
    expect(byDate.get(LAST_DAY)).toEqual({ date: LAST_DAY, clicks: 62, impressions: 1120 })
  })

  it('leaves a day with no data as a gap rather than as a nought', async () => {
    const body = performanceOverviewResponseSchema.parse(await (await overview(mine)).json())
    const missing = body.series.find((point) => point.date === MISSING_DAY)
    expect(missing).toEqual({ date: MISSING_DAY, clicks: null, impressions: null })
  })

  it('marks the connect day, each publication and each applied improvement', async () => {
    const body = performanceOverviewResponseSchema.parse(await (await overview(mine)).json())
    const kinds = body.markers.map((marker) => `${marker.kind}@${marker.date}`)

    expect(kinds).toContain(`gsc_connected@${CONNECTED_ON}`)
    expect(kinds).toContain('article_published@2026-08-30')
    expect(kinds).toContain('optimize_applied@2026-08-30')
  })

  it('gives no verdict to anything, because nothing computes one yet', async () => {
    const body = performanceOverviewResponseSchema.parse(await (await overview(mine)).json())
    const article = body.results.find((result) => result.id === articleId)
    const page = body.results.find((result) => result.id === opportunityId)

    expect(article?.label).toBe('unrated')
    expect(page?.label).toBe('unrated')
    // The figures behind the verdict are real all the same, so the day a
    // verdict exists the row is already carrying the right numbers.
    expect(page?.impressions).toBeGreaterThan(0)
  })

  it('bites: a store with no search data at all is not the same answer', async () => {
    const full = performanceOverviewResponseSchema.parse(await (await overview(mine)).json())
    await harness.pool.query('DELETE FROM gsc_daily WHERE account_id = $1', [mine])

    const bare = performanceOverviewResponseSchema.parse(await (await overview(mine)).json())
    expect(full.series.length).toBeGreaterThan(0)
    expect(bare.series).toEqual([])
    // Still connected, still a 200: an empty chart is not an error.
    expect(bare.connected).toBe(true)
  })

  it('answers a store with no Search Console with the connect card, never an error', async () => {
    await harness.pool.query('DELETE FROM gsc_conns WHERE account_id = $1', [mine])
    const response = await overview(mine)

    expect(response.status).toBe(200)
    const body = performanceOverviewResponseSchema.parse(await response.json())
    expect(body).toEqual({ connected: false, series: [], markers: [], results: [] })
  })

  it('keeps a store whose grant died looking at its own history', async () => {
    await harness.pool.query(
      "UPDATE gsc_conns SET invalidated_at = now() WHERE account_id = $1",
      [mine],
    )
    const body = performanceOverviewResponseSchema.parse(await (await overview(mine)).json())
    expect(body.connected).toBe(true)
    expect(body.series.length).toBeGreaterThan(0)
  })

  it('shows only this account’s pages, never another store’s', async () => {
    const body = performanceOverviewResponseSchema.parse(await (await overview(mine)).json())
    const bytes = JSON.stringify(body)
    expect(bytes).not.toContain('elsewhere.example')
  })

  it('lists the searches a store was found for, against the period before', async () => {
    const response = await searchConsole(mine, 'dimension=query&window=28d')
    expect(response.status).toBe(200)
    const body = searchConsoleResponseSchema.parse(await response.json())

    const row = body.rows.find((r) => r.key === 'wide trail shoes')
    expect(row).toBeDefined()
    expect(row!.clicks).toBe(30)
    expect(row!.impressions).toBe(700)
    expect(row!.ctr).toBeCloseTo(30 / 700)
    // The 28 days before hold the 2026-08-02 row: five clicks at position 13.
    expect(row!.deltaClicks).toBe(25)
    expect(row!.deltaPosition).toBeCloseTo(-7)
    expect(row!.pageType).toBeNull()
  })

  it('names each page’s type from the store’s own inventory', async () => {
    const body = searchConsoleResponseSchema.parse(
      await (await searchConsole(mine, 'dimension=page&window=28d')).json(),
    )
    const collection = body.rows.find((r) => r.key === 'https://example.com/collections/trail')
    expect(collection!.pageType).toBe('collection')

    // A page the inventory has never seen is left unlabelled rather than guessed.
    const article = body.rows.find((r) => r.key === 'https://example.com/blogs/journal/wide-fit')
    expect(article!.pageType).toBeNull()
  })

  it('badges a row with the open opportunity about it, and links to it', async () => {
    // The applied one is completed, so it is not what puts a badge on the row.
    const open = await harness.pool.query<{ id: string }>(
      `INSERT INTO opportunities
         (account_id, signal_type, entity_type, entity_ref, evidence_json, impact, impact_score,
          confidence, reason_template_key, recommended_action, status, rules_version)
       VALUES ($1, 'low_ctr_at_strong_rank', 'url', 'https://example.com/collections/trail', '[]'::jsonb,
               'medium', 50, 60, 'low_ctr_at_strong_rank.below_own_curve', 'optimize', 'new', 'test-rules')
       RETURNING id`,
      [mine],
    )

    const body = searchConsoleResponseSchema.parse(
      await (await searchConsole(mine, 'dimension=page&window=28d')).json(),
    )
    const row = body.rows.find((r) => r.key === 'https://example.com/collections/trail')
    expect(row!.signals).toEqual([{ signalType: 'low_ctr_at_strong_rank', opportunityId: open.rows[0]!.id }])
  })

  it('refuses a range it does not serve rather than guessing one', async () => {
    const response = await searchConsole(mine, 'dimension=query&window=6m')
    expect(response.status).toBe(422)
  })

  it('answers a store with no Search Console with an empty table, never an error', async () => {
    await harness.pool.query('DELETE FROM gsc_conns WHERE account_id = $1', [mine])
    const response = await searchConsole(mine, 'dimension=query&window=28d')

    expect(response.status).toBe(200)
    expect(searchConsoleResponseSchema.parse(await response.json())).toEqual({ rows: [], cursor: null })
  })

  it('never shows one store another store’s searches', async () => {
    const body = searchConsoleResponseSchema.parse(
      await (await searchConsole(theirs, 'dimension=page&window=28d')).json(),
    )
    expect(body.rows.map((row) => row.key)).toEqual(['https://elsewhere.example/secret'])
  })
})

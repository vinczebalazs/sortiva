import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { accountScope } from './scope'
import {
  confirmedKeywordTerms,
  gscCurveSamples,
  gscPageQueryTotals,
  insertCtrCurve,
  latestCtrCurve,
  listQueryClusters,
  upsertGscQueryDaily,
  upsertQueryClusters,
  type GscQueryDailyInput,
} from './repositories/search'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from './testing'

/**
 * The search-intelligence reads and writes against a real Postgres, because
 * every claim worth making about them is database behaviour: that a window is
 * summed the way an average position has to be summed, that rebuilding a store's
 * clusters keeps their identity, and that a refit adds to the history rather
 * than replacing it.
 */

const available = await databaseAvailable()

function row(over: Partial<GscQueryDailyInput> = {}): GscQueryDailyInput {
  return {
    date: '2026-08-01',
    page: 'https://shop.example/collections/boots',
    query: 'waterproof boots',
    device: 'DESKTOP',
    country: 'gbr',
    clicks: 1,
    impressions: 10,
    position: 5,
    ...over,
  }
}

describe.skipIf(!available)('reading a store\'s search history back out', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('search_intelligence')
    pool = ctx.pool
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    accountId = await insertAccount(pool, 'search@example.com')
  })

  it('sums a window per page and search, weighting position by impressions', async () => {
    const scope = accountScope(accountId)
    await upsertGscQueryDaily(ctx.db, scope, [
      row({ date: '2026-08-01', impressions: 900, clicks: 30, position: 4 }),
      row({ date: '2026-08-02', impressions: 100, clicks: 5, position: 14 }),
      // A second device on the same day: one search to a merchant, two rows here.
      row({ date: '2026-08-02', device: 'MOBILE', impressions: 1_000, clicks: 20, position: 4 }),
    ])

    const [total] = await gscPageQueryTotals(
      ctx.db,
      scope,
      { startDate: '2026-08-01', endDate: '2026-08-31' },
      1,
    )

    expect(total?.impressions).toBe(2_000)
    expect(total?.clicks).toBe(55)
    // Averaging the three positions would give 7.3. Weighted by impressions it
    // is 4.5 — the 100-impression row at position 14 cannot pull the figure as
    // hard as the two thousand-impression rows at position 4.
    expect(total?.position).toBeCloseTo(4.5, 2)
  })

  it('leaves out searches below the floor the caller passes', async () => {
    const scope = accountScope(accountId)
    await upsertGscQueryDaily(ctx.db, scope, [
      row({ query: 'waterproof boots', impressions: 500 }),
      row({ query: 'boot laces', impressions: 3 }),
    ])

    const totals = await gscPageQueryTotals(
      ctx.db,
      scope,
      { startDate: '2026-08-01', endDate: '2026-08-31' },
      10,
    )
    expect(totals.map((t) => t.query)).toEqual(['waterproof boots'])
  })

  it('stays inside its window and inside its own account', async () => {
    const scope = accountScope(accountId)
    const otherId = await insertAccount(pool, 'other@example.com')
    await upsertGscQueryDaily(ctx.db, scope, [
      row({ date: '2026-08-01' }),
      row({ date: '2026-07-01', query: 'older search' }),
    ])
    await upsertGscQueryDaily(ctx.db, accountScope(otherId), [row({ query: 'someone else' })])

    const totals = await gscPageQueryTotals(
      ctx.db,
      scope,
      { startDate: '2026-08-01', endDate: '2026-08-31' },
      1,
    )
    expect(totals.map((t) => t.query)).toEqual(['waterproof boots'])
  })

  it('collapses pages and days into one sample per search per whole position', async () => {
    const scope = accountScope(accountId)
    await upsertGscQueryDaily(ctx.db, scope, [
      row({ page: 'https://shop.example/a', position: 3.2, impressions: 100, clicks: 9 }),
      row({ page: 'https://shop.example/b', position: 2.8, impressions: 50, clicks: 4 }),
      row({ date: '2026-08-02', page: 'https://shop.example/a', position: 8, impressions: 20, clicks: 1 }),
    ])

    const samples = await gscCurveSamples(ctx.db, scope, {
      startDate: '2026-08-01',
      endDate: '2026-08-31',
    })

    // Both pages sat at position 3 once rounded, so they are two observations of
    // position 3 rather than two pages.
    const atThree = samples.find((s) => s.position === 3)
    expect(atThree?.impressions).toBe(150)
    expect(atThree?.clicks).toBe(13)
    expect(samples.find((s) => s.position === 8)?.impressions).toBe(20)
  })
})

describe.skipIf(!available)('the clusters and the curve', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('search_intelligence_write')
    pool = ctx.pool
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    accountId = await insertAccount(pool, 'clusters@example.com')
  })

  it('keeps a cluster\'s identity across a rebuild, so nothing pointing at it is orphaned', async () => {
    const scope = accountScope(accountId)
    const first = await upsertQueryClusters(ctx.db, scope, [
      { headQuery: 'waterproof boots', memberQueries: ['best waterproof boots'] },
    ])
    expect(first).toEqual({ inserted: 1, updated: 0 })

    const [before] = await listQueryClusters(ctx.db, scope)

    const second = await upsertQueryClusters(ctx.db, scope, [
      { headQuery: 'waterproof boots', memberQueries: ['best waterproof boots', 'waterproof boots uk'] },
      { headQuery: 'wool socks', memberQueries: [] },
    ])
    expect(second).toEqual({ inserted: 1, updated: 1 })

    const after = await listQueryClusters(ctx.db, scope)
    const rebuilt = after.find((c) => c.headQuery === 'waterproof boots')
    // Same row, new members. An article written from this cluster still points
    // at something.
    expect(rebuilt?.clusterId).toBe(before?.clusterId)
    expect(rebuilt?.memberQueries).toEqual(['best waterproof boots', 'waterproof boots uk'])
    expect(after).toHaveLength(2)
  })

  it('keeps a cluster the store is no longer shown for', async () => {
    const scope = accountScope(accountId)
    await upsertQueryClusters(ctx.db, scope, [
      { headQuery: 'waterproof boots', memberQueries: [] },
      { headQuery: 'summer sandals', memberQueries: [] },
    ])
    await upsertQueryClusters(ctx.db, scope, [{ headQuery: 'waterproof boots', memberQueries: [] }])

    const after = await listQueryClusters(ctx.db, scope)
    expect(after.map((c) => c.headQuery)).toEqual(['summer sandals', 'waterproof boots'])
  })

  it('does not touch another store\'s clusters', async () => {
    const otherId = await insertAccount(pool, 'other-clusters@example.com')
    await upsertQueryClusters(ctx.db, accountScope(otherId), [
      { headQuery: 'waterproof boots', memberQueries: ['theirs'] },
    ])
    await upsertQueryClusters(ctx.db, accountScope(accountId), [
      { headQuery: 'waterproof boots', memberQueries: ['ours'] },
    ])

    expect((await listQueryClusters(ctx.db, accountScope(otherId)))[0]?.memberQueries).toEqual(['theirs'])
    expect((await listQueryClusters(ctx.db, accountScope(accountId)))[0]?.memberQueries).toEqual(['ours'])
  })

  it('adds each refit to the history and reports the newest as live', async () => {
    const scope = accountScope(accountId)
    await insertCtrCurve(ctx.db, scope, {
      curveJson: { '1': 0.25 },
      sampleN: 1_000,
      brandedExcluded: false,
      fittedAt: new Date('2026-08-03T07:00:00Z'),
    })
    await insertCtrCurve(ctx.db, scope, {
      curveJson: { '1': 0.31 },
      sampleN: 4_000,
      brandedExcluded: true,
      fittedAt: new Date('2026-08-10T07:00:00Z'),
    })

    const live = await latestCtrCurve(ctx.db, scope)
    expect(live?.curveJson).toEqual({ '1': 0.31 })
    expect(live?.sampleN).toBe(4_000)
    expect(live?.brandedExcluded).toBe(true)
  })

  it('has no curve for a store that has never been fitted', async () => {
    expect(await latestCtrCurve(ctx.db, accountScope(accountId))).toBeUndefined()
  })

  it('reads back only the search terms the merchant confirmed', async () => {
    await pool.query(
      `insert into keywords (account_id, term, language, country, source, confirmed)
       values ($1, 'waterproof boots', 'en', 'GB', 'auto', true),
              ($1, 'boot laces', 'en', 'GB', 'auto', false)`,
      [accountId],
    )
    expect(await confirmedKeywordTerms(ctx.db, accountScope(accountId))).toEqual(['waterproof boots'])
  })
})

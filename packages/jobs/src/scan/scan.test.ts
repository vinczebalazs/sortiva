import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  accountScope,
  latestCtrCurve,
  listQueryClusters,
  saveGscGrant,
  selectGscProperty,
  upsertGscQueryDaily,
  type GscQueryDailyInput,
} from '@sortiva/db'
import {
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { silentLogger, standardCurve } from '@sortiva/core'
import { rules } from '@sortiva/rules'
import { refitCtrCurveForAccount } from './ctr-curve'
import { rebuildQueryClustersForAccount } from './clusters'

const available = await databaseAvailable()

/**
 * The two weekly pieces end to end: real Search Console rows in the database,
 * the real thresholds out of `packages/rules`, and the rows they leave behind.
 *
 * "Now" is fixed so the windows are, and the fixture dates are placed inside
 * them rather than the other way round.
 */

const NOW = new Date('2026-09-02T07:00:00Z')
const curveConfig = rules().defaults.ctr_curve
const clusterConfig = rules().defaults.clusters

/** A date inside every window this card uses, allowing for Google's reporting lag. */
function dayInWindow(offset = 0): string {
  const date = new Date(NOW)
  date.setUTCDate(date.getUTCDate() - rules().defaults.search_console.data_lag_days - offset)
  return date.toISOString().slice(0, 10)
}

function row(over: Partial<GscQueryDailyInput> = {}): GscQueryDailyInput {
  return {
    date: dayInWindow(),
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

describe.skipIf(!available)('the weekly work behind Search Console detection', () => {
  let ctx: TestDb
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('scan_weekly')
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(ctx.pool)
    accountId = await insertAccount(ctx.pool, 'scan@example.com')
  })

  async function connectSearchConsole(): Promise<void> {
    const scope = accountScope(accountId)
    await saveGscGrant(ctx.db, scope, { tokens: 'stored' })
    await selectGscProperty(ctx.db, scope, {
      property: 'sc-domain:shop.example',
      connectedAt: NOW,
    })
  }

  /** Rows generated from a known curve, spread across positions and days. */
  function curveFixture(scale: number, exponent: number): GscQueryDailyInput[] {
    const rows: GscQueryDailyInput[] = []
    for (let position = 1; position <= curveConfig.max_position; position += 1) {
      const impressions = 500 * position
      rows.push(
        row({
          date: dayInWindow(position),
          query: `boots kind ${position}`,
          position,
          impressions,
          clicks: Math.round(impressions * scale * Math.pow(position, exponent)),
        }),
      )
    }
    return rows
  }

  it('fits a curve from the store\'s own data and stores it as the live one', async () => {
    await connectSearchConsole()
    await upsertGscQueryDaily(ctx.db, accountScope(accountId), curveFixture(0.3, -1.15))

    const outcome = await refitCtrCurveForAccount(
      { db: ctx.db, now: () => NOW, logger: silentLogger },
      accountId,
    )

    expect(outcome.status).toBe('fitted')
    expect(outcome).toMatchObject({ source: 'fitted' })

    const live = await latestCtrCurve(ctx.db, accountScope(accountId))
    expect(live).toBeDefined()
    const curve = live?.curveJson as Record<string, number>
    expect(curve['1']).toBeCloseTo(0.3, 2)
    expect(curve['10']).toBeCloseTo(0.3 * Math.pow(10, -1.15), 3)
    expect(live?.sampleN).toBeGreaterThanOrEqual(curveConfig.min_sample_impressions)
  })

  it('stores the fallback curve when the store has too little history', async () => {
    await connectSearchConsole()
    // A single day of one search: real data, nowhere near enough of it.
    await upsertGscQueryDaily(ctx.db, accountScope(accountId), [row({ impressions: 40, clicks: 3 })])

    const outcome = await refitCtrCurveForAccount(
      { db: ctx.db, now: () => NOW, logger: silentLogger },
      accountId,
    )

    expect(outcome).toMatchObject({ status: 'fitted', source: 'standard' })
    const live = await latestCtrCurve(ctx.db, accountScope(accountId))
    expect(live?.curveJson).toEqual(standardCurve(curveConfig))
    expect(live?.sampleN).toBeLessThan(curveConfig.min_sample_impressions)
  })

  it('writes no curve at all for a store with no Search Console connection', async () => {
    await upsertGscQueryDaily(ctx.db, accountScope(accountId), curveFixture(0.3, -1.15))

    const outcome = await refitCtrCurveForAccount(
      { db: ctx.db, now: () => NOW, logger: silentLogger },
      accountId,
    )

    expect(outcome).toEqual({ status: 'not_connected' })
    expect(await latestCtrCurve(ctx.db, accountScope(accountId))).toBeUndefined()
  })

  it('ignores search history from outside the fit window', async () => {
    await connectSearchConsole()
    const old = new Date(NOW)
    old.setUTCDate(old.getUTCDate() - curveConfig.window_days - 30)
    await upsertGscQueryDaily(
      ctx.db,
      accountScope(accountId),
      curveFixture(0.3, -1.15).map((r, i) => ({
        ...r,
        date: new Date(old.getTime() - i * 86_400_000).toISOString().slice(0, 10),
      })),
    )

    const outcome = await refitCtrCurveForAccount(
      { db: ctx.db, now: () => NOW, logger: silentLogger },
      accountId,
    )
    // The data exists, but not in the window — so the fit has nothing and falls
    // back, which is what proves the window is doing something.
    expect(outcome).toMatchObject({ status: 'fitted', source: 'standard' })
  })

  it('builds the store\'s intents from what it was actually shown for', async () => {
    await connectSearchConsole()
    const big = clusterConfig.head_min_impressions * 4
    const small = clusterConfig.head_min_impressions - 1
    await upsertGscQueryDaily(ctx.db, accountScope(accountId), [
      row({ query: 'waterproof boots', impressions: big, clicks: 40 }),
      row({ query: 'best waterproof boots', impressions: small, clicks: 5 }),
      // Same search, a second page. One intent, two pages — which is what the
      // share table is for, not a second cluster.
      row({ query: 'waterproof boots', page: 'https://shop.example/blogs/news/boots', impressions: small }),
      row({ query: 'wool socks', impressions: big, clicks: 12 }),
      // Below the noise floor: never reaches a cluster.
      row({ query: 'boot laces', impressions: clusterConfig.min_query_impressions - 1 }),
    ])

    const outcome = await rebuildQueryClustersForAccount(
      { db: ctx.db, now: () => NOW, logger: silentLogger },
      accountId,
    )
    expect(outcome).toMatchObject({ status: 'rebuilt', inserted: 2 })

    const stored = await listQueryClusters(ctx.db, accountScope(accountId))
    expect(stored.map((c) => c.headQuery)).toEqual(['waterproof boots', 'wool socks'])
    expect(stored[0]?.memberQueries).toEqual(['best waterproof boots'])
  })

  it('running the rebuild twice converges instead of duplicating', async () => {
    await connectSearchConsole()
    await upsertGscQueryDaily(ctx.db, accountScope(accountId), [
      row({ query: 'waterproof boots', impressions: clusterConfig.head_min_impressions * 4 }),
    ])

    const deps = { db: ctx.db, now: () => NOW, logger: silentLogger }
    const first = await rebuildQueryClustersForAccount(deps, accountId)
    const second = await rebuildQueryClustersForAccount(deps, accountId)

    expect(first).toMatchObject({ inserted: 1, updated: 0 })
    expect(second).toMatchObject({ inserted: 0, updated: 1 })
    expect(await listQueryClusters(ctx.db, accountScope(accountId))).toHaveLength(1)
  })

  it('builds nothing for a store with no Search Console connection', async () => {
    const outcome = await rebuildQueryClustersForAccount(
      { db: ctx.db, now: () => NOW, logger: silentLogger },
      accountId,
    )
    expect(outcome).toEqual({ status: 'not_connected' })
  })
})

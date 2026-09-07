import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { silentLogger } from '@sortiva/core'
import { MockSeoDataProvider } from '@sortiva/providers/seo/mock'
import {
  accountScope,
  listOpenOpportunities,
  saveGscGrant,
  selectGscProperty,
  setRulesOverride,
  systemScope,
  upsertGscQueryDaily,
  upsertStorePages,
} from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { rules, versionCarriesOverrides } from '@sortiva/rules'
import { runSignalScan, type RunSignalScanDeps } from './run'

/**
 * The weekly scan reading `rules_overrides` — the whole point of the table:
 * a threshold moved for one store, without a deploy, changing that store's
 * decisions and nobody else's.
 *
 * Two stores are seeded identically. One is given an override that narrows the
 * position band a striking-distance opportunity must fall in, so the page they
 * both rank seventh for stops qualifying for that one store.
 */

const available = await databaseAvailable()
const NOW = new Date('2026-09-07T07:00:00Z')
const searchConsole = rules().defaults.search_console
const system = systemScope('rules_overrides holds rows that belong to every store')

/**
 * Every test here runs two whole signal scans against real Postgres, twice what
 * the scan suite next door does. The default five seconds is enough alone and
 * not enough with the rest of the suite running beside it, which is a slow test
 * rather than a broken one.
 */
const SCAN_PAIR_TIMEOUT = 30_000

function deps(ctx: TestDb): RunSignalScanDeps {
  return {
    db: ctx.db,
    pool: ctx.pool,
    seo: new MockSeoDataProvider({}),
    capture: { capture: () => {} },
    now: () => NOW,
    logger: silentLogger,
  }
}

function dayInWindow(): string {
  const date = new Date(NOW)
  date.setUTCDate(date.getUTCDate() - searchConsole.data_lag_days)
  return date.toISOString().slice(0, 10)
}

async function seedStoreWithSearchData(ctx: TestDb, accountId: string): Promise<void> {
  const scope = accountScope(accountId)
  await upsertStorePages(ctx.db, scope, [
    {
      url: 'https://shop.example/collections/trail-shoes',
      pageType: 'collection',
      handle: 'trail-shoes',
      shopifyId: 'gid://shopify/Collection/1',
      title: 'Trail Running Shoes',
      seoTitle: 'Trail Running Shoes | Shop',
      seoDescription: 'Buy trail running shoes.',
      headings: [],
      bodyHtml: null,
      outboundInternalLinks: [],
      familyIds: [],
      checksum: 'a',
    },
    // A second page with nothing written for search engines, so both stores
    // always have at least one opportunity that the overridden threshold has
    // nothing to do with — otherwise an assertion over "every row" could pass
    // by there being no rows.
    {
      url: 'https://shop.example/collections/road-shoes',
      pageType: 'collection',
      handle: 'road-shoes',
      shopifyId: 'gid://shopify/Collection/2',
      title: 'Road Running Shoes',
      seoTitle: null,
      seoDescription: null,
      headings: [],
      bodyHtml: null,
      outboundInternalLinks: [],
      familyIds: [],
      checksum: 'b',
    },
  ])
  await saveGscGrant(ctx.db, scope, { tokens: 'test-tokens' })
  await selectGscProperty(ctx.db, scope, { property: 'sc-domain:shop.example', connectedAt: NOW })
  await upsertGscQueryDaily(ctx.db, scope, [
    {
      date: dayInWindow(),
      page: 'https://shop.example/collections/trail-shoes',
      query: 'trail running shoes',
      device: 'DESKTOP',
      country: 'gbr',
      clicks: 40,
      impressions: 500,
      position: 7,
    },
  ])
}

describe.skipIf(!available)('a threshold moved for one store', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let overridden: string
  let control: string

  beforeAll(async () => {
    ctx = await setupTestDb('signal-scan-rules-overrides')
    pool = ctx.pool
  }, 60_000)

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    overridden = await insertAccount(pool, 'overridden@example.com')
    control = await insertAccount(pool, 'control@example.com')
    await seedStoreWithSearchData(ctx, overridden)
    await seedStoreWithSearchData(ctx, control)
  }, SCAN_PAIR_TIMEOUT)

  it('changes that store\'s decisions and leaves every other store alone', async () => {
    await setRulesOverride(ctx.db, system, {
      accountId: overridden,
      // The store ranks seventh; narrowing the band to end at fifth means this
      // page is no longer close enough to the first page to be worth pushing.
      key: 'signals.striking_distance.position_max',
      value: 5,
      updatedBy: 'operator@example.com',
    })

    await runSignalScan(deps(ctx), overridden, 'weekly', 'weekly-2026-W36')
    await runSignalScan(deps(ctx), control, 'weekly', 'weekly-2026-W36')

    const theirs = await listOpenOpportunities(ctx.db, accountScope(overridden))
    const others = await listOpenOpportunities(ctx.db, accountScope(control))

    expect(theirs.some((row) => row.signalType === 'striking_distance')).toBe(false)
    expect(others.some((row) => row.signalType === 'striking_distance')).toBe(true)
  }, SCAN_PAIR_TIMEOUT)

  it('stamps a version on the overridden store\'s rows that says so, and the plain one on everybody else\'s', async () => {
    // Widened rather than narrowed, so the overridden store still has rows to
    // read a stamp off — the point here is the stamp, not the suppression.
    await setRulesOverride(ctx.db, system, {
      accountId: overridden,
      key: 'signals.striking_distance.position_max',
      value: rules().defaults.signals.striking_distance.position_max + 1,
      updatedBy: 'operator@example.com',
    })

    await runSignalScan(deps(ctx), overridden, 'weekly', 'weekly-2026-W36')
    await runSignalScan(deps(ctx), control, 'weekly', 'weekly-2026-W36')

    const theirs = await listOpenOpportunities(ctx.db, accountScope(overridden))
    const others = await listOpenOpportunities(ctx.db, accountScope(control))
    expect(theirs.length).toBeGreaterThan(0)
    expect(others.length).toBeGreaterThan(0)

    for (const row of theirs) {
      expect(versionCarriesOverrides(row.rulesVersion)).toBe(true)
      expect(row.rulesVersion.startsWith(rules().rulesVersion)).toBe(true)
    }
    for (const row of others) expect(row.rulesVersion).toBe(rules().rulesVersion)
  }, SCAN_PAIR_TIMEOUT)

  it('applies a row aimed at every store to every store', async () => {
    await setRulesOverride(ctx.db, system, {
      key: 'signals.striking_distance.position_max',
      value: 5,
      updatedBy: 'operator@example.com',
    })

    await runSignalScan(deps(ctx), overridden, 'weekly', 'weekly-2026-W36')
    await runSignalScan(deps(ctx), control, 'weekly', 'weekly-2026-W36')

    for (const accountId of [overridden, control]) {
      const open = await listOpenOpportunities(ctx.db, accountScope(accountId))
      expect(open.length).toBeGreaterThan(0)
      expect(open.some((row) => row.signalType === 'striking_distance')).toBe(false)
      expect(open.every((row) => versionCarriesOverrides(row.rulesVersion))).toBe(true)
    }
  }, SCAN_PAIR_TIMEOUT)

  it('refuses to scan a store whose override is malformed rather than scanning it on the old numbers', async () => {
    await setRulesOverride(ctx.db, system, {
      accountId: overridden,
      key: 'signals.striking_distance.position_maximum',
      value: 5,
      updatedBy: 'operator@example.com',
    })

    await expect(runSignalScan(deps(ctx), overridden, 'weekly', 'weekly-2026-W36')).rejects.toThrow(
      /is not a threshold this product has/,
    )
    expect(await listOpenOpportunities(ctx.db, accountScope(overridden))).toEqual([])

    // And only that store: the bad row is aimed at one account.
    await runSignalScan(deps(ctx), control, 'weekly', 'weekly-2026-W36')
    expect((await listOpenOpportunities(ctx.db, accountScope(control))).length).toBeGreaterThan(0)
  }, SCAN_PAIR_TIMEOUT)
})

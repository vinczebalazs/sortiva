import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { silentLogger, type AnalyticsEvent } from '@sortiva/core'
import { MockSeoDataProvider } from '@sortiva/providers/seo/mock'
import {
  accountScope,
  dismissOpportunityGuarded,
  findOpportunityById,
  listOpenOpportunities,
  saveGscGrant,
  selectGscProperty,
  undismissOpportunity,
  upsertGscQueryDaily,
  upsertOpportunity,
  upsertStorePages,
  type GscQueryDailyInput,
  type OpportunityRow,
} from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { rules } from '@sortiva/rules'
import { runSignalScan, type RunSignalScanDeps } from './run'

const available = await databaseAvailable()

/**
 * `runSignalScan` end to end, against real Postgres: a synthetic store,
 * both with and without Search Console, and the two convergence properties
 * this card's own done-when names — "running the weekly scan twice
 * converges" — and the `T3.6` scheduled-audit HIGH finding this card closes.
 */

const NOW = new Date('2026-09-07T07:00:00Z') // a Monday, not that the engine cares here
const searchConsole = rules().defaults.search_console

function deps(ctx: TestDb, capture: AnalyticsEvent[] = []): RunSignalScanDeps {
  return {
    db: ctx.db,
    pool: ctx.pool,
    seo: new MockSeoDataProvider({}),
    capture: { capture: (e) => capture.push(e) },
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
    page: 'https://shop.example/collections/trail-shoes',
    query: 'trail running shoes',
    device: 'DESKTOP',
    country: 'gbr',
    clicks: 40,
    impressions: 500,
    position: 7,
    ...over,
  }
}

async function seedStorePages(ctx: TestDb, accountId: string): Promise<void> {
  await upsertStorePages(ctx.db, accountScope(accountId), [
    {
      url: 'https://shop.example/collections/trail-shoes',
      pageType: 'collection',
      handle: 'trail-shoes',
      shopifyId: 'gid://shopify/Collection/1',
      title: 'Trail Running Shoes',
      seoTitle: null,
      seoDescription: null,
      headings: [],
      bodyHtml: null,
      outboundInternalLinks: [],
      familyIds: [],
      checksum: 'a',
    },
    {
      url: 'https://shop.example/collections/road-shoes',
      pageType: 'collection',
      handle: 'road-shoes',
      shopifyId: 'gid://shopify/Collection/2',
      title: 'Road Running Shoes',
      seoTitle: 'Road Running Shoes | Shop',
      seoDescription: 'Buy road running shoes.',
      headings: [],
      bodyHtml: null,
      outboundInternalLinks: [],
      familyIds: [],
      checksum: 'b',
    },
  ])
}

describe.skipIf(!available)('runSignalScan against a real store (main §7.5, §7.9; T3.6 HIGH finding)', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('signal-scan-run')
    pool = ctx.pool
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    accountId = await insertAccount(pool, 'signal-scan@example.com')
  })

  it('Limited Intelligence mode: no GSC connection — catalogue signals still run, GSC ones do not', async () => {
    await seedStorePages(ctx, accountId)

    const outcome = await runSignalScan(deps(ctx), accountId, 'onboarding', `onboarding-${accountId}`)
    expect(outcome.status).toBe('completed')
    expect(outcome.opportunitiesCreated).toBeGreaterThan(0)

    const open = await listOpenOpportunities(ctx.db, accountScope(accountId))
    expect(open.some((o) => o.signalType === 'missing_or_weak_metadata')).toBe(true)
    expect(open.some((o) => o.signalType === 'striking_distance')).toBe(false)
    // Every row this mode produces is stamped, so the merchant sees the badge (main §7.11).
    for (const row of open) expect(row.limitedIntelligence).toBe(true)
  })

  it('Full mode: a live GSC connection lets the GSC-dependent signals run too', async () => {
    await seedStorePages(ctx, accountId)
    const scope = accountScope(accountId)
    await saveGscGrant(ctx.db, scope, { tokens: 'test-tokens' })
    await selectGscProperty(ctx.db, scope, { property: 'sc-domain:shop.example', connectedAt: NOW })
    await upsertGscQueryDaily(ctx.db, scope, [gscRow()])

    const outcome = await runSignalScan(deps(ctx), accountId, 'onboarding', `onboarding-${accountId}`)
    expect(outcome.status).toBe('completed')

    const open = await listOpenOpportunities(ctx.db, scope)
    const strikingDistance = open.find((o) => o.signalType === 'striking_distance')
    expect(strikingDistance).toBeDefined()
    expect(strikingDistance?.limitedIntelligence).toBe(false)
    expect(open.some((o) => o.signalType === 'missing_or_weak_metadata')).toBe(true)
  })

  it('redelivering the exact same run converges: a second call with the same run_id does no further work', async () => {
    await seedStorePages(ctx, accountId)
    const runId = `onboarding-${accountId}`

    const first = await runSignalScan(deps(ctx), accountId, 'onboarding', runId)
    expect(first.status).toBe('completed')
    const afterFirst = await listOpenOpportunities(ctx.db, accountScope(accountId))

    const second = await runSignalScan(deps(ctx), accountId, 'onboarding', runId)
    expect(second.status).toBe('already_completed')
    const afterSecond = await listOpenOpportunities(ctx.db, accountScope(accountId))

    expect(afterSecond.length).toBe(afterFirst.length)
  })

  it('running the weekly scan twice — two genuinely separate passes — converges: no duplicate rows, no duplicate tasks', async () => {
    await seedStorePages(ctx, accountId)
    const scope = accountScope(accountId)

    const first = await runSignalScan(deps(ctx), accountId, 'weekly', 'weekly-2026-W36')
    const afterFirst = await listOpenOpportunities(ctx.db, scope)
    expect(afterFirst.length).toBeGreaterThan(0)

    // A second, later week's pass over an unchanged store: every signal
    // re-detects the same entity, so `upsertOpportunity`'s own dedupe must
    // update the open rows rather than duplicate them.
    const second = await runSignalScan(deps(ctx), accountId, 'weekly', 'weekly-2026-W37')
    expect(second.status).toBe('completed')
    expect(second.opportunitiesCreated).toBe(0)
    expect(second.opportunitiesUpdated).toBe(first.opportunitiesCreated)

    const afterSecond = await listOpenOpportunities(ctx.db, scope)
    expect(afterSecond.length).toBe(afterFirst.length)
    expect(new Set(afterSecond.map((r) => r.id))).toEqual(new Set(afterFirst.map((r) => r.id)))
  })

  it('a suggestion the merchant turned down is not put back by the next scan', async () => {
    await seedStorePages(ctx, accountId)
    const scope = accountScope(accountId)

    const first = await runSignalScan(deps(ctx), accountId, 'weekly', 'weekly-2026-W36')
    const openAfterFirst = await listOpenOpportunities(ctx.db, scope)
    const declined = openAfterFirst.find((o) => o.signalType === 'missing_or_weak_metadata')!
    expect(declined).toBeDefined()

    await dismissOpportunityGuarded(ctx.db, scope, declined.id)

    // Nothing about the store has changed, so this pass detects exactly the
    // same signal on exactly the same page — the situation that used to hand
    // the merchant back the advice they had just refused.
    const second = await runSignalScan(deps(ctx), accountId, 'weekly', 'weekly-2026-W37')
    expect(second.status).toBe('completed')

    const openAfterSecond = await listOpenOpportunities(ctx.db, scope)
    expect(
      openAfterSecond.filter(
        (o) => o.signalType === declined.signalType && o.entityRef === declined.entityRef,
      ),
    ).toEqual([])
    expect((await findOpportunityById(ctx.db, scope, declined.id))?.status).toBe('dismissed')

    // Everything else the same pass found is untouched — the refusal is about
    // one kind of advice on one page, not about the store.
    expect(openAfterSecond.length).toBe(openAfterFirst.length - 1)
    expect(second.opportunitiesCreated).toBe(0)
    expect(second.opportunitiesUpdated).toBe(first.opportunitiesCreated - 1)
  })

  it('a merchant who says no to one kind of advice about a page still hears a new kind about the same page', async () => {
    await seedStorePages(ctx, accountId)
    const scope = accountScope(accountId)
    const page = 'https://shop.example/collections/trail-shoes'

    await runSignalScan(deps(ctx), accountId, 'weekly', 'weekly-2026-W36')
    const metadata = (await listOpenOpportunities(ctx.db, scope)).find(
      (o) => o.signalType === 'missing_or_weak_metadata' && o.entityRef === page,
    )!
    expect(metadata).toBeDefined()
    await dismissOpportunityGuarded(ctx.db, scope, metadata.id)

    // Search Console arrives, and it says this same page is close to the first
    // results page for a query — a different problem, on the same address, that
    // the merchant has never been asked about.
    await saveGscGrant(ctx.db, scope, { tokens: 'test-tokens' })
    await selectGscProperty(ctx.db, scope, { property: 'sc-domain:shop.example', connectedAt: NOW })
    await upsertGscQueryDaily(ctx.db, scope, [gscRow()])
    await runSignalScan(deps(ctx), accountId, 'weekly', 'weekly-2026-W37')

    const stillOpen = await listOpenOpportunities(ctx.db, scope)
    expect(stillOpen.some((o) => o.signalType === 'missing_or_weak_metadata' && o.entityRef === page)).toBe(false)
    expect(stillOpen.some((o) => o.signalType === 'striking_distance' && o.entityRef === page)).toBe(true)
  })

  it('"show dismissed" undo puts the suggestion back, and the next scan keeps it', async () => {
    await seedStorePages(ctx, accountId)
    const scope = accountScope(accountId)

    const first = await runSignalScan(deps(ctx), accountId, 'weekly', 'weekly-2026-W36')
    const declined = (await listOpenOpportunities(ctx.db, scope)).find(
      (o) => o.signalType === 'missing_or_weak_metadata',
    )!
    await dismissOpportunityGuarded(ctx.db, scope, declined.id)

    const restored = await undismissOpportunity(ctx.db, scope, declined.id)
    expect(restored?.status).toBe('new')

    // The refusal is lifted, so the pass writes to the row again instead of
    // stepping over it — the count is what proves that: every candidate the
    // first pass created is written again, none held back — and it is the same
    // row, not a replacement.
    const after = await runSignalScan(deps(ctx), accountId, 'weekly', 'weekly-2026-W37')
    expect(after.opportunitiesCreated).toBe(0)
    expect(after.opportunitiesUpdated).toBe(first.opportunitiesCreated)
    const open = await listOpenOpportunities(ctx.db, scope)
    const back = open.filter(
      (o) => o.signalType === declined.signalType && o.entityRef === declined.entityRef,
    )
    expect(back.map((o) => o.id)).toEqual([declined.id])
  })

  it('closes the T3.6 HIGH finding: a technical blocker discovered on re-scan moves a new/accepted row to blocked, and clears it once the blocker is gone', async () => {
    await seedStorePages(ctx, accountId)
    const scope = accountScope(accountId)
    const blockedUrl = 'https://shop.example/collections/trail-shoes'

    // First pass: the missing-metadata page becomes an open, un-blocked OPTIMIZE opportunity.
    await runSignalScan(deps(ctx), accountId, 'weekly', 'weekly-2026-W36')
    const beforeBlock = (await listOpenOpportunities(ctx.db, scope)).find(
      (o) => o.signalType === 'missing_or_weak_metadata' && o.entityRef === blockedUrl,
    )
    expect(beforeBlock).toBeDefined()
    expect(beforeBlock?.status).toBe('new')

    // A technical blocker on the same URL is discovered — planted directly,
    // since no `indexing_issue` detector exists anywhere yet (DECISIONS
    // 2026-09-03 T3.6). This is exactly the shape `openTechnicalBlockers`
    // reads: an open FIX opportunity of signal_type `indexing_issue` on the
    // same entity_ref.
    await upsertOpportunity(ctx.db, scope, {
      accountId,
      signalType: 'indexing_issue',
      entityType: 'url',
      entityRef: blockedUrl,
      evidence: [{ key: 'reason', value: 'not_indexed', source: 'gsc', fetchedAt: NOW.toISOString() }],
      confidence: 70,
      confidenceBand: 'medium',
      reasonTemplateKey: 'indexing_issue.fix_not_indexed',
      reasonParams: {},
      recommendedAction: 'FIX',
      preconditions: [],
      status: 'new',
      rulesVersion: 'test-rules-version',
      limitedIntelligence: false,
      detectedAt: NOW.toISOString(),
      rawScore: 1,
      tasks: [],
      impactScore: 50,
      impact: 'medium',
    })

    // Re-scanning now must block the row — the exact gap the audit found:
    // without this fix the row would stay `new`/`accepted` forever.
    await runSignalScan(deps(ctx), accountId, 'weekly', 'weekly-2026-W37')
    const blocked = await findOpportunityById(ctx.db, scope, beforeBlock!.id)
    expect(blocked?.status).toBe('blocked')
    expect((blocked?.preconditionsJson as string[]).includes('indexing_issue')).toBe(true)

    // Clearing the blocker (dismissing/expiring it out of the open set) and
    // re-scanning must return the row to `new` — the promised
    // "re-checked automatically" the other half of this fix completes.
    const stillOpen = await listOpenOpportunities(ctx.db, scope)
    const blocker = stillOpen.find((o: OpportunityRow) => o.signalType === 'indexing_issue')!
    const { transitionOpportunityStatus } = await import('@sortiva/db')
    await transitionOpportunityStatus(ctx.db, scope, blocker.id, { from: ['new'], to: 'dismissed' })

    await runSignalScan(deps(ctx), accountId, 'weekly', 'weekly-2026-W38')
    const unblocked = await findOpportunityById(ctx.db, scope, beforeBlock!.id)
    expect(unblocked?.status).toBe('new')
  })
})

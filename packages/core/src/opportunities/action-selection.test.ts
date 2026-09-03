import { describe, expect, it } from 'vitest'
import { scenario } from '../fixtures'
import { brandTokens, fitCtrCurve, type ClusterShareRow } from '../search'
import { detectStrikingDistance } from '../signals/striking-distance'
import { detectLowCtrAtStrongRank } from '../signals/low-ctr'
import { detectContentDecay } from '../signals/decay'
import { detectCannibalization, type WeeklyShareRow } from '../signals/cannibalization'
import { detectUncoveredCommercialQueries } from '../signals/uncovered-query'
import { detectCatalogRichnessGaps } from '../signals/richness-gap'
import { detectCompetitorCoverageGaps } from '../signals/competitor-gap'
import { substanceInventory } from '../signals/substance'
import type { ExistingCoverage, KeywordCandidate } from '../signals/candidates'
import {
  FETCHED_AT,
  clustersFrom,
  inventoryFor,
  rulesLayer,
  scenarioRows,
  shiftWeeks,
  substanceInputFor,
  totalsInWindow,
  windowEndingOn,
} from '../signals/testing'
import { selectAction } from './action-selection'
import type { ExistingPageIntentGapSignal, IndexingIssueSignal } from './p1-signal-shapes'

/**
 * Main §7.8's eight worked examples, run end to end: real detector output
 * (hand-built input only where §7.8's own signal has no detector — worked
 * examples 4 and 8, see `p1-signal-shapes.ts`) through `selectAction`, and the
 * action asserted against the spec's own "Action" column. Worked example 3's
 * store is asserted as the fixture declares it, per `T3.5`'s own precedent
 * (DECISIONS 2026-09-03 T3.5), not by editing the shared fixture other lanes
 * read.
 */

const WINDOW = windowEndingOn('2026-01-28', 28)
const layer = rulesLayer()

describe('worked example 1 — striking distance', () => {
  it('selects OPTIMIZE', () => {
    const rows = totalsInWindow(scenarioRows(1), WINDOW)
    const result = detectStrikingDistance({
      clusters: clustersFrom(rows),
      rows,
      pages: inventoryFor(rows),
      config: layer.signals.striking_distance,
      window: WINDOW,
      fetchedAt: FETCHED_AT,
    })
    const signal = result.detections.find((row) => row.page === '/collections/trail-running')
    expect(signal).toBeDefined()
    expect(selectAction(signal!).action).toBe('OPTIMIZE')
  })

  it('selects REFRESH when the same signal lands on one of our own articles', () => {
    const rows = totalsInWindow(scenarioRows(1), WINDOW)
    const result = detectStrikingDistance({
      clusters: clustersFrom(rows),
      rows,
      pages: inventoryFor(rows),
      config: layer.signals.striking_distance,
      window: WINDOW,
      fetchedAt: FETCHED_AT,
    })
    const signal = result.detections.find((row) => row.page === '/collections/trail-running')
    expect(signal).toBeDefined()
    // main §7.4's own split for this signal only: our article is rewritten,
    // never handed a recommendation card (§10.5). `pageType` is overridden
    // directly rather than re-run through the detector, which has no way to
    // produce `article_ours` for a `/collections/...` address.
    expect(selectAction({ ...signal!, pageType: 'article_ours' }).action).toBe('REFRESH')
  })
})

describe('worked example 2 — strong rank, weak CTR', () => {
  it('selects OPTIMIZE', () => {
    const rows = totalsInWindow(scenarioRows(2), WINDOW)
    const tokens = brandTokens({ domainNormalized: scenario(2).store.domain })
    const fit = fitCtrCurve({ rows, config: layer.ctr_curve, brandTokens: tokens })
    const result = detectLowCtrAtStrongRank({
      clusters: clustersFrom(rows),
      rows,
      pages: inventoryFor(rows),
      curve: { curve: fit.curve, source: fit.source, windowDays: layer.ctr_curve.window_days },
      brandTokens: tokens,
      config: layer.signals.low_ctr_at_strong_rank,
      window: WINDOW,
      fetchedAt: FETCHED_AT,
    })
    const signal = result.detections.find((row) => row.page === '/collections/trail-running')
    expect(signal).toBeDefined()
    expect(selectAction(signal!).action).toBe('OPTIMIZE')
  })
})

describe('worked example 3 — missing coverage', () => {
  const ROAD_RUNNING = 'road_running'

  it('selects CREATE', () => {
    const example = scenario(3)
    const products = substanceInputFor(example.store, ROAD_RUNNING)
    const substance = substanceInventory(products, layer.gates.substance_floor)
    expect(substance.passes).toBe(true)
    expect(example.hasSuitableUrl).toBe(false)

    const candidate: KeywordCandidate = {
      keyword: 'best road running shoes',
      monthlySearchVolume: layer.gates.demand_floor.monthly_search_volume_min * 4,
      intentClass: 'buying_guide',
      familyIds: [ROAD_RUNNING],
      source: 'merchant_seed',
    }
    const coverage = new Map<string, ExistingCoverage>([
      ['best road running shoes', { strength: 'none' }],
    ])

    const signals = detectUncoveredCommercialQueries({
      candidates: [candidate],
      coverage,
      familiesWithSubstance: new Set([ROAD_RUNNING]),
      config: layer.signals.uncovered_commercial_query,
      gates: layer.gates,
      fetchedAt: FETCHED_AT,
    })

    expect(signals).toHaveLength(1)
    expect(selectAction(signals[0]!).action).toBe('CREATE')
  })
})

describe('worked example 4 — existing intent gap', () => {
  it('selects OPTIMIZE', () => {
    // No detector exists for this signal yet (main §10.3's subtopic-coverage
    // analysis is Lane E's `T6.2`) — the evidence is the example's own
    // numbers, hand-built the same way `T3.5` hand-built worked example 3's
    // input rather than editing shared machinery. See `p1-signal-shapes.ts`.
    const signal: ExistingPageIntentGapSignal = {
      signalType: 'existing_page_intent_gap',
      page: '/collections/hiking-boots',
      pageType: 'collection',
      clusterHead: 'waterproof hiking boots',
      position: 11,
      clusterImpressions: 5200,
      missingSubtopics: ['waterproofing', 'terrain', 'fit', 'sizing'],
      evidence: [],
    }
    expect(selectAction(signal).action).toBe('OPTIMIZE')
  })
})

describe('worked example 5 — cannibalization', () => {
  const CLUSTER = 'trail running shoes'
  const COLLECTION = '/collections/trail-running'
  const BLOG = '/blogs/guides/trail-running-shoes'
  const PRODUCT = '/products/trail-running-1'
  const WEEKLY_IMPRESSIONS: Readonly<Record<string, readonly number[]>> = {
    [COLLECTION]: [1500, 500, 500, 500],
    [BLOG]: [600, 1200, 300, 300],
    [PRODUCT]: [450, 450, 450, 450],
  }
  const WEEKLY_CLICKS: Readonly<Record<string, readonly number[]>> = {
    [COLLECTION]: [40, 10, 10, 10],
    [BLOG]: [11, 10, 10, 10],
    [PRODUCT]: [9, 7, 7, 7],
  }
  const POSITIONS: Readonly<Record<string, number>> = {
    [COLLECTION]: 8.2,
    [BLOG]: 9.6,
    [PRODUCT]: 12.4,
  }
  const WEEK_STARTS = ['2026-01-01', '2026-01-08', '2026-01-15', '2026-01-22']

  function weeklyRows(): WeeklyShareRow[] {
    const out: WeeklyShareRow[] = []
    for (const [page, impressions] of Object.entries(WEEKLY_IMPRESSIONS)) {
      impressions.forEach((value, week) => {
        out.push({
          weekStart: WEEK_STARTS[week] as string,
          page,
          query: CLUSTER,
          impressions: value,
          clicks: WEEKLY_CLICKS[page]?.[week] ?? 0,
          position: POSITIONS[page] ?? null,
        })
      })
    }
    return out
  }

  function totalsOf(rows: readonly WeeklyShareRow[]): ClusterShareRow[] {
    const acc = new Map<string, { page: string; clicks: number; impressions: number }>()
    for (const row of rows) {
      const into = acc.get(row.page) ?? { page: row.page, clicks: 0, impressions: 0 }
      into.clicks += row.clicks
      into.impressions += row.impressions
      acc.set(row.page, into)
    }
    return [...acc.values()].map((row) => ({
      page: row.page,
      query: CLUSTER,
      clicks: row.clicks,
      impressions: row.impressions,
      position: POSITIONS[row.page] ?? null,
    }))
  }

  const EXAMPLE_INTENTS = {
    [COLLECTION]: 'buying_guide',
    [BLOG]: 'buying_guide',
    [PRODUCT]: 'buying_guide',
  } as const

  it('selects FIX (the row also allows OPTIMIZE — DECISIONS 2026-09-03 T3.6)', () => {
    const weekly = weeklyRows()
    const clusterRows = totalsOf(weekly)
    const storeRows = totalsInWindow(scenario(5).store.gsc, WINDOW)
    const rows = [...storeRows, ...clusterRows]

    const result = detectCannibalization({
      clusters: clustersFrom(rows),
      rows,
      weeklyRows: weekly,
      pages: inventoryFor(rows, EXAMPLE_INTENTS),
      config: layer.signals.cannibalization,
      window: WINDOW,
      fetchedAt: FETCHED_AT,
    })

    const signal = result.detections.find((row) => row.clusterHead === CLUSTER)
    expect(signal).toBeDefined()
    expect(['FIX', 'OPTIMIZE']).toContain(selectAction(signal!).action)
    expect(selectAction(signal!).action).toBe('FIX')
  })
})

describe('worked example 6 — decay', () => {
  it('selects REFRESH', () => {
    const config = layer.signals.content_decay
    const baselineWindow = shiftWeeks(WINDOW, config.comparison_window_offset_weeks)
    const rows = totalsInWindow(scenarioRows(6), WINDOW)
    const baselineRows = totalsInWindow(scenarioRows(6), baselineWindow)
    const pages = inventoryFor([...rows, ...baselineRows])

    const result = detectContentDecay({
      rows,
      baselineRows,
      pages,
      config,
      window: WINDOW,
      baselineWindow,
      priorConsecutiveEvaluations: new Map([['/blogs/guides/choosing-trail-shoes', 1]]),
      fetchedAt: FETCHED_AT,
    })

    const signal = result.detections.find((row) => row.page === '/blogs/guides/choosing-trail-shoes')
    expect(signal).toBeDefined()
    expect(selectAction(signal!).action).toBe('REFRESH')
  })
})

describe('worked example 7 — catalog richness gap', () => {
  it('selects HOLD, with the precondition named', () => {
    const TRAIL_RUNNING = 'trail-running'
    const example = scenario(7)
    const products = substanceInputFor(example.store, TRAIL_RUNNING)
    const substance = substanceInventory(products, layer.gates.substance_floor)
    expect(substance.passes).toBe(false)

    const signals = detectCatalogRichnessGaps({
      candidates: [
        {
          keyword: 'best trail running shoes',
          monthlySearchVolume: layer.gates.demand_floor.monthly_search_volume_min * 4,
          intentClass: 'buying_guide',
          familyIds: [TRAIL_RUNNING],
          source: 'merchant_seed',
          winnability: layer.gates.winnability.limited_intelligence_constant,
          substance,
        },
      ],
      gates: layer.gates,
      fetchedAt: FETCHED_AT,
    })

    expect(signals).toHaveLength(1)
    const result = selectAction(signals[0]!)
    expect(result.action).toBe('HOLD')
    expect(result.preconditions).toContain('catalog_richness_gap')
  })
})

describe('worked example 8 — indexing issue (P1)', () => {
  it('selects FIX', () => {
    // No detector exists (main §12.4's URL Inspection API is P1, "not
    // required for launch") — hand-built the same way example 4 is.
    const signal: IndexingIssueSignal = {
      signalType: 'indexing_issue',
      page: '/collections/hiking-boots',
      pageType: 'collection',
      reason: 'not_indexed',
      evidence: [],
    }
    expect(selectAction(signal).action).toBe('FIX')
  })
})

describe('the competitor-gap fixture the founder unblocked — DECISIONS 2026-09-03', () => {
  function gapCandidate(overrides: Record<string, unknown> = {}) {
    return {
      keyword: 'trail running shoes',
      monthlySearchVolume: layer.gates.demand_floor.monthly_search_volume_min * 4,
      intentClass: 'buying_guide' as const,
      familyIds: ['trail-running'],
      source: 'merchant_seed' as const,
      competitorRankings: [
        { domain: 'rival-one.com', position: 3, url: 'https://rival-one.com/a' },
        { domain: 'rival-two.com', position: 7, url: 'https://rival-two.com/b' },
      ],
      ourPosition: null,
      ourUrl: null,
      ...overrides,
    }
  }

  it('yields CREATE when we hold no relevant URL', () => {
    const signals = detectCompetitorCoverageGaps({
      candidates: [gapCandidate()],
      config: layer.signals.competitor_coverage_gap,
      fetchedAt: FETCHED_AT,
    })
    expect(signals).toHaveLength(1)
    expect(signals[0]!.ourRankingUrl).toBeNull()
    expect(selectAction(signals[0]!).action).toBe('CREATE')
  })

  it('yields OPTIMIZE with a URL at #18 — the fixture main §7.8’s own example names', () => {
    const signals = detectCompetitorCoverageGaps({
      candidates: [
        gapCandidate({ ourPosition: 18, ourUrl: '/collections/trail-running' }),
      ],
      config: layer.signals.competitor_coverage_gap,
      fetchedAt: FETCHED_AT,
    })
    expect(signals).toHaveLength(1)
    expect(signals[0]!.ourPosition).toBe(18)
    expect(signals[0]!.ourRankingUrl).toBe('/collections/trail-running')
    expect(selectAction(signals[0]!).action).toBe('OPTIMIZE')
  })
})

import { describe, expect, it } from 'vitest'
import { scenario } from '../fixtures'
import { buildOpportunityDraft, type OpportunityBuildContext } from '../opportunities/build'
import type { ClusterShareRow } from '../search'
import { type WeeklyShareRow, detectCannibalization } from '../signals/cannibalization'
import {
  FETCHED_AT,
  clustersFrom,
  inventoryFor,
  rulesLayer,
  totalsInWindow,
  windowEndingOn,
} from '../signals/testing'
import { buildConsolidationRecommendation, consolidationInputFromSignal } from './consolidation'
import { renderConsolidationView } from './view'

/**
 * Worked example 5, all the way through: three of the store's own URLs turning
 * up for one search, and what the merchant is told to do about it.
 *
 * The weekly split below re-arranges the shared fixture's own 28-day totals so
 * that the leading URL changes week to week — the word "alternate" in the
 * example — without changing any of its numbers. The signal detector's test
 * does the same thing for the same reason; the shared fixture cannot express a
 * leader that moves, and other lanes read it.
 */
const WINDOW = windowEndingOn('2026-01-28', 28)
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

const INTENTS = {
  [COLLECTION]: 'buying_guide',
  [BLOG]: 'buying_guide',
  [PRODUCT]: 'buying_guide',
} as const

const layer = rulesLayer()

function detected() {
  const weekly = weeklyRows()
  const clusterRows = totalsOf(weekly)
  const rows = [...totalsInWindow(scenario(5).store.gsc, WINDOW), ...clusterRows]
  const result = detectCannibalization({
    clusters: clustersFrom(rows),
    rows,
    weeklyRows: weekly,
    pages: inventoryFor(rows, INTENTS),
    config: layer.signals.cannibalization,
    window: WINDOW,
    fetchedAt: FETCHED_AT,
  })
  const signal = result.detections.find((row) => row.clusterHead === CLUSTER)
  expect(signal, 'example 5 must produce a cannibalization signal').toBeDefined()
  return signal!
}

function buildContext(): OpportunityBuildContext {
  return {
    accountId: 'acct_1',
    limitedIntelligence: false,
    rulesVersion: 'test-rules-version',
    winnability: 0.5,
    patternMultiplierClamp: {
      min: layer.learning.patterns.multiplier_clamp_min,
      max: layer.learning.patterns.multiplier_clamp_max,
    },
    detectedAt: FETCHED_AT,
  }
}

describe('worked example 5 produces a FIX with the three task kinds', () => {
  const signal = detected()
  const draft = buildOpportunityDraft(signal, buildContext(), layer.scoring)

  it('is a FIX on the shared search, not on any one of the pages', () => {
    expect(draft.recommendedAction).toBe('FIX')
    expect(draft.entityType).toBe('query_cluster')
    expect(draft.entityRef).toBe(CLUSTER)
  })

  it('decomposes into designating a primary URL, realigning links, and consolidating', () => {
    expect(draft.tasks.map((task) => task.kind).sort()).toEqual([
      'consolidate',
      'internal_links',
      'primary_url',
    ])
  })

  it('waits on the merchant rather than acting — nothing about a FIX runs by itself', () => {
    expect(draft.status).toBe('new')
  })
})

describe('the consolidation recommendation the merchant reads', () => {
  const signal = detected()
  /** Two of the store's other pages link into the pages we are about to demote. */
  const inventory = [
    { url: '/pages/shoe-guide', outboundInternalLinks: [BLOG, '/pages/about'] },
    { url: '/collections/all', outboundInternalLinks: [PRODUCT] },
    { url: '/pages/about', outboundInternalLinks: [COLLECTION] },
  ]
  const recommendation = buildConsolidationRecommendation(
    consolidationInputFromSignal(signal, inventory),
  )

  it('names the page Google already shows most as the one to keep, and says so', () => {
    expect(recommendation.primary.url).toBe(COLLECTION)
    expect(recommendation.primaryReasonTemplateKey).toBe('fix.consolidation.primary.mostShown')
    expect(recommendation.primaryReasonParams).toEqual({ query: CLUSTER, sharePercent: 42 })
    expect(recommendation.secondary.map((page) => page.url)).toEqual([BLOG, PRODUCT])
  })

  it('lists only the links that point at a page being demoted', () => {
    expect(recommendation.linkRealignment).toEqual([
      { fromUrl: '/collections/all', currentTarget: PRODUCT, suggestedTarget: COLLECTION },
      { fromUrl: '/pages/shoe-guide', currentTarget: BLOG, suggestedTarget: COLLECTION },
    ])
  })

  it('suggests no canonical at all here, because none of the losers is the same kind of page', () => {
    expect(recommendation.canonicalSuggestions).toEqual([])
    expect(recommendation.canonicalNotAdvisedFor).toEqual([BLOG, PRODUCT])
  })

  it('renders as three sections and the line saying we changed nothing', () => {
    const view = renderConsolidationView(recommendation)
    expect(view.sections.map((section) => section.kind)).toEqual([
      'primary_url',
      'internal_links',
      'canonical',
    ])
    expect(view.trustLineKey).toBe('fix.trustLine')
    for (const section of view.sections) {
      expect(section.lines.length).toBeGreaterThan(0)
    }
  })
})

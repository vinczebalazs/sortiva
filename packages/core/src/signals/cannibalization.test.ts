import { describe, expect, it } from 'vitest'
import { scenario } from '../fixtures'
import type { ClusterShareRow } from '../search'
import { type WeeklyShareRow, detectCannibalization } from './cannibalization'
import {
  FETCHED_AT,
  clustersFrom,
  inventoryFor,
  rulesLayer,
  totalsInWindow,
  windowEndingOn,
} from './testing'
import { indexPages } from './types'

const WINDOW = windowEndingOn('2026-01-28', 28)
const CLUSTER = 'trail running shoes'
const COLLECTION = '/collections/trail-running'
const BLOG = '/blogs/guides/trail-running-shoes'
const PRODUCT = '/products/trail-running-1'

/**
 * Worked example 5: a collection, a blog post and a product URL alternating for
 * one search.
 *
 * **The fixture states the alternation and does not encode it.** Its rows split
 * each URL's 28-day totals evenly across every day, which cannot express a
 * leader that changes; the collection leads all four weeks. So the weekly split
 * below re-arranges *the same totals* — asserted against the fixture's own
 * numbers before anything is detected — so that the leading URL changes, which
 * is what the example's word "alternate" means. Nothing else about the example
 * is touched, and the evidence the detector reports is still the fixture's.
 * The shared fixture is left alone deliberately; other lanes' tests read it.
 */
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

function exampleWeeklyRows(): WeeklyShareRow[] {
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

describe('worked example 5 — cannibalization', () => {
  const layer = rulesLayer()
  const weeklyRows = exampleWeeklyRows()
  const clusterRows = totalsOf(weeklyRows)
  const storeRows = totalsInWindow(scenario(5).store.gsc, WINDOW)
  const rows = [...storeRows, ...clusterRows]
  const clusters = clustersFrom(rows)

  it('re-arranges the fixture’s totals without changing them', () => {
    const fromFixture = totalsInWindow(scenario(5).gsc, WINDOW)
    for (const row of clusterRows) {
      const original = fromFixture.find((other) => other.page === row.page)
      expect(original?.impressions).toBe(row.impressions)
      expect(original?.clicks).toBe(row.clicks)
    }
    expect(clusterRows.map((row) => row.impressions).sort((a, b) => b - a)).toEqual([
      3000, 2400, 1800,
    ])
  })

  function detect(intents: Readonly<Record<string, 'buying_guide'>> | undefined) {
    return detectCannibalization({
      clusters,
      rows,
      weeklyRows,
      pages: intents ? inventoryFor(rows, intents) : inventoryFor(rows),
      config: layer.signals.cannibalization,
      window: WINDOW,
      fetchedAt: FETCHED_AT,
    })
  }

  it('finds the three URLs sharing the search, with the example’s own numbers', () => {
    const result = detect(EXAMPLE_INTENTS)
    const found = result.detections.find((row) => row.clusterHead === CLUSTER)
    expect(found).toBeDefined()
    expect(found?.clusterImpressions).toBe(7200)
    expect(found?.competing.map((page) => page.page)).toEqual([COLLECTION, BLOG, PRODUCT])
    expect(found?.competing.map((page) => page.impressions)).toEqual([3000, 2400, 1800])
    expect(found?.competing.map((page) => Math.round(page.impressionShare * 1000) / 1000)).toEqual([
      0.417, 0.333, 0.25,
    ])
    expect(found?.competing.map((page) => page.pageType)).toEqual([
      'collection',
      'blog_article',
      'product',
    ])
  })

  it('is validated by the leading URL changing week to week', () => {
    const found = detect(EXAMPLE_INTENTS).detections.find((row) => row.clusterHead === CLUSTER)
    expect(found?.weeklyLeaders.map((week) => week.page)).toEqual([
      COLLECTION,
      BLOG,
      COLLECTION,
      COLLECTION,
    ])
    expect(found?.leaderChanges).toBe(2)
    expect(found?.validation).toEqual({
      validated: true,
      intentClass: 'buying_guide',
      via: 'alternation',
    })
  })

  /**
   * The store's inventory has a column for what job a page is doing and
   * nothing in the product writes it yet. Until something does, this is where
   * every real store lands — which is why the candidate is returned with the
   * reason rather than dropped or waved through.
   */
  it('is not a finding while we do not know what job the pages are doing', () => {
    const result = detect(undefined)
    expect(result.detections).toHaveLength(0)
    const held = result.unvalidated.find((row) => row.clusterHead === CLUSTER)
    expect(held?.validation).toEqual({ validated: false, reason: 'intent_class_unknown' })
    expect(held?.competing).toHaveLength(3)
  })

  it('names no action', () => {
    const found = detect(EXAMPLE_INTENTS).detections.find((row) => row.clusterHead === CLUSTER)
    expect(JSON.stringify(found)).not.toMatch(/OPTIMIZE|CREATE|REFRESH|HOLD|"FIX"/)
  })
})

describe('what makes a candidate', () => {
  const config = rulesLayer().signals.cannibalization
  const pages = indexPages([
    { url: '/collections/a', pageType: 'collection', intentClass: 'buying_guide' },
    { url: '/collections/b', pageType: 'collection', intentClass: 'buying_guide' },
  ])
  const clusters = [{ headQuery: 'garden shears', memberQueries: [] }]

  function detect(rows: readonly ClusterShareRow[]) {
    const weeklyRows: WeeklyShareRow[] = rows.flatMap((row, index) =>
      WEEK_STARTS.map((weekStart, week) => ({
        ...row,
        weekStart,
        // Flip the leader on the second week, so the candidate that reaches
        // validation is held or passed by the intent test alone.
        impressions: Math.round(row.impressions / 4) * (week === 1 && index === 1 ? 3 : 1),
      })),
    )
    return detectCannibalization({
      clusters,
      rows,
      weeklyRows,
      pages,
      config,
      window: WINDOW,
      fetchedAt: FETCHED_AT,
    })
  }

  it('a page holding only a sliver of the search is not competing for it', () => {
    const result = detect([
      { page: '/collections/a', query: 'garden shears', clicks: 90, impressions: 9500, position: 6 },
      { page: '/collections/b', query: 'garden shears', clicks: 2, impressions: 500, position: 8 },
    ])
    expect(result.detections).toHaveLength(0)
    expect(result.unvalidated).toHaveLength(0)
  })

  it('a page too far down the results is not competing either', () => {
    const result = detect([
      { page: '/collections/a', query: 'garden shears', clicks: 90, impressions: 5000, position: 6 },
      { page: '/collections/b', query: 'garden shears', clicks: 10, impressions: 4000, position: 44 },
    ])
    expect(result.detections).toHaveLength(0)
    expect(result.unvalidated).toHaveLength(0)
  })

  it('two pages each holding a real share, both on the first few pages, is', () => {
    const result = detect([
      { page: '/collections/a', query: 'garden shears', clicks: 90, impressions: 5000, position: 6 },
      { page: '/collections/b', query: 'garden shears', clicks: 40, impressions: 4000, position: 9 },
    ])
    expect(result.detections.map((row) => row.clusterHead)).toEqual(['garden shears'])
  })
})

describe('validation', () => {
  const config = rulesLayer().signals.cannibalization
  const rows: ClusterShareRow[] = [
    { page: '/collections/a', query: 'garden shears', clicks: 90, impressions: 5000, position: 6 },
    { page: '/collections/b', query: 'garden shears', clicks: 40, impressions: 4000, position: 9 },
  ]
  const clusters = [{ headQuery: 'garden shears', memberQueries: [] }]

  /** Four weeks with the same leader throughout: no alternation to find. */
  const steadyWeeks: WeeklyShareRow[] = rows.flatMap((row) =>
    WEEK_STARTS.map((weekStart) => ({ ...row, weekStart, impressions: row.impressions / 4 })),
  )

  function detect(options: {
    intents?: Record<string, 'buying_guide' | 'how_to'>
    baselineClicks?: number
  }) {
    return detectCannibalization({
      clusters,
      rows,
      weeklyRows: steadyWeeks,
      ...(options.baselineClicks === undefined
        ? {}
        : {
            baselineRows: [
              {
                page: '/collections/a',
                query: 'garden shears',
                clicks: options.baselineClicks,
                impressions: 9000,
                position: 5,
              },
            ],
          }),
      pages: indexPages([
        {
          url: '/collections/a',
          pageType: 'collection',
          intentClass: options.intents?.['/collections/a'] ?? 'buying_guide',
        },
        {
          url: '/collections/b',
          pageType: 'collection',
          intentClass: options.intents?.['/collections/b'] ?? 'buying_guide',
        },
      ]),
      config,
      window: WINDOW,
      fetchedAt: FETCHED_AT,
    })
  }

  it('pages doing different jobs are not competing, however much they overlap', () => {
    const result = detect({ intents: { '/collections/b': 'how_to' } })
    expect(result.detections).toHaveLength(0)
    expect(result.unvalidated[0]?.validation).toEqual({
      validated: false,
      reason: 'different_intent_class',
    })
  })

  it('a steady leader and no earlier window to compare against holds the candidate', () => {
    const result = detect({})
    expect(result.detections).toHaveLength(0)
    expect(result.unvalidated[0]?.validation).toEqual({
      validated: false,
      reason: 'no_baseline_to_compare',
    })
  })

  it('a steady leader and a search still earning what it did holds it too', () => {
    const result = detect({ baselineClicks: 100 })
    expect(result.unvalidated[0]?.validation).toEqual({
      validated: false,
      reason: 'no_alternation_or_loss',
    })
    expect(result.unvalidated[0]?.clicksVsBaselineRatio).toBeCloseTo(130 / 100, 12)
  })

  it('a steady leader on a search that has lost ground is a finding', () => {
    const result = detect({ baselineClicks: 400 })
    expect(result.detections[0]?.validation).toEqual({
      validated: true,
      intentClass: 'buying_guide',
      via: 'aggregate_loss',
    })
    expect(result.detections[0]?.baselineClusterClicks).toBe(400)
  })
})

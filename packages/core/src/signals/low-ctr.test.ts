import { describe, expect, it } from 'vitest'
import { scenario } from '../fixtures'
import { brandTokens, fitCtrCurve, standardCurve } from '../search'
import { detectLowCtrAtStrongRank } from './low-ctr'
import {
  FETCHED_AT,
  clustersFrom,
  inventoryFor,
  rulesLayer,
  scenarioRows,
  totalsInWindow,
  windowEndingOn,
} from './testing'
import { indexPages } from './types'

const WINDOW = windowEndingOn('2026-01-28', 28)

/**
 * Worked example 2: position 3.4, 15,000 impressions, 310 clicks, and a click
 * rate below what this store's own curve expects at that position. The curve is
 * fitted here by the same code the weekly refit uses, from the same store's
 * data — never handed in, because the whole point of the signal is that the
 * comparison is the store's own.
 */
describe('worked example 2 — strong rank, weak CTR', () => {
  const rows = totalsInWindow(scenarioRows(2), WINDOW)
  const layer = rulesLayer()
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
  const found = result.detections.find((row) => row.page === '/collections/trail-running')

  it('detects the example on the page the example names', () => {
    expect(found).toBeDefined()
    expect(found?.signalType).toBe('low_ctr_at_strong_rank')
    expect(found?.clusterHead).toBe('trail running shoes')
  })

  it('reproduces the example’s evidence numbers exactly', () => {
    expect(found?.position).toBeCloseTo(3.4, 10)
    expect(found?.clusterImpressions).toBe(15000)
    expect(found?.clusterClicks).toBe(310)
    expect(found?.observedCtr).toBeCloseTo(310 / 15000, 12)
  })

  it('measures against the store’s own curve, and says which curve that was', () => {
    expect(found?.curveSource).toBe(fit.source)
    expect(found?.predictedCtr).toBeGreaterThan(found?.observedCtr ?? 0)
    expect(found?.ctrRatio).toBeLessThan(layer.signals.low_ctr_at_strong_rank.observed_vs_predicted_ctr_ratio_max)
    expect(found?.brandedExcluded).toBe(true)
  })

  it('dates the predicted rate to the curve’s window, not the signal’s', () => {
    const byKey = new Map((found?.evidence ?? []).map((fact) => [fact.key, fact]))
    expect(byKey.get('impressions')?.window).toBe('28d')
    expect(byKey.get('predicted_ctr')?.window).toBe(`${layer.ctr_curve.window_days}d`)
    for (const fact of found?.evidence ?? []) expect(fact.fetchedAt).toBe(FETCHED_AT)
  })

  it('names no action', () => {
    expect(JSON.stringify(found)).not.toMatch(/OPTIMIZE|CREATE|REFRESH|HOLD/)
  })
})

describe('what stops the signal firing', () => {
  const layer = rulesLayer()
  const config = layer.signals.low_ctr_at_strong_rank
  const curve = {
    curve: standardCurve(layer.ctr_curve),
    source: 'standard' as const,
    windowDays: layer.ctr_curve.window_days,
  }
  const pages = indexPages([
    { url: '/collections/a', pageType: 'collection', intentClass: null },
    { url: '/collections/b', pageType: 'collection', intentClass: null },
    { url: '/collections/c', pageType: 'collection', intentClass: null },
  ])

  /** Two quiet pages either side, so the store has a middle to be judged against. */
  const quiet = [
    { page: '/collections/b', query: 'other thing', clicks: 5, impressions: 1000, position: 12 },
    { page: '/collections/c', query: 'third thing', clicks: 4, impressions: 900, position: 14 },
  ]

  function detect(row: { clicks: number; impressions: number; position: number }) {
    return detectLowCtrAtStrongRank({
      clusters: [
        { headQuery: 'garden shears', memberQueries: [] },
        { headQuery: 'other thing', memberQueries: [] },
        { headQuery: 'third thing', memberQueries: [] },
      ],
      rows: [{ page: '/collections/a', query: 'garden shears', ...row }, ...quiet],
      pages,
      curve,
      config,
      window: WINDOW,
      fetchedAt: FETCHED_AT,
    }).detections
  }

  it('a ranking that is not strong — the snippet is not what is losing the click', () => {
    expect(detect({ clicks: 20, impressions: 20000, position: 9 })).toHaveLength(0)
  })

  it('a page carrying too little traffic for the click rate to mean anything', () => {
    expect(detect({ clicks: 1, impressions: 300, position: 3 })).toHaveLength(0)
  })

  it('a click rate the store’s curve is happy with', () => {
    // The fallback curve expects 10% at position 3; this page beats it.
    expect(detect({ clicks: 2400, impressions: 20000, position: 3 })).toHaveLength(0)
  })

  it('fires when the rank is strong, the traffic is real and the clicks are not', () => {
    const found = detect({ clicks: 200, impressions: 20000, position: 3 })
    expect(found).toHaveLength(1)
    expect(found[0]?.page).toBe('/collections/a')
  })
})

describe('searches for the store’s own name', () => {
  const layer = rulesLayer()
  const curve = {
    curve: standardCurve(layer.ctr_curve),
    source: 'standard' as const,
    windowDays: layer.ctr_curve.window_days,
  }

  /**
   * Four ordinary pages so the store has a middle, one page that only ever
   * appears for the shop's own name, and one page that appears for a real
   * search. Both of the last two are clicked far below what the curve expects.
   */
  const quiet = ['q1', 'q2', 'q3', 'q4'].map((handle, index) => ({
    page: `/collections/${handle}`,
    query: `${handle} thing`,
    clicks: 5,
    impressions: 1000 + index * 100,
    position: 12,
  }))
  const rows = [
    { page: '/collections/brand', query: 'nordic socks', clicks: 200, impressions: 20000, position: 1 },
    { page: '/collections/a', query: 'garden shears', clicks: 200, impressions: 20000, position: 3 },
    ...quiet,
  ]
  const pages = indexPages(
    [...rows.map((row) => row.page)].map((url) => ({
      url,
      pageType: 'collection' as const,
      intentClass: null,
    })),
  )
  const clusters = rows.map((row) => ({ headQuery: row.query, memberQueries: [] }))

  function detect(tokens?: readonly string[]) {
    return detectLowCtrAtStrongRank({
      clusters,
      rows,
      pages,
      curve,
      ...(tokens ? { brandTokens: tokens } : {}),
      config: layer.signals.low_ctr_at_strong_rank,
      window: WINDOW,
      fetchedAt: FETCHED_AT,
    }).detections
  }

  it('are left out of the comparison entirely', () => {
    const found = detect(brandTokens({ domainNormalized: 'nordic-socks.dk' }))
    expect(found.map((row) => row.page)).toEqual(['/collections/a'])
    expect(found[0]?.brandedExcluded).toBe(true)
  })

  it('are judged like any other search when we cannot tell which words are the brand', () => {
    const found = detect()
    expect(found.map((row) => row.page).sort()).toEqual([
      '/collections/a',
      '/collections/brand',
    ])
    expect(found[0]?.brandedExcluded).toBe(false)
  })
})

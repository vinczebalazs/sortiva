import { describe, expect, it } from 'vitest'
import { scenario } from '../fixtures'
import { detectContentDecay } from './decay'
import {
  FETCHED_AT,
  inventoryFor,
  rulesLayer,
  scenarioRows,
  shiftWeeks,
  totalsInWindow,
  windowEndingOn,
} from './testing'
import { indexPages } from './types'

const WINDOW = windowEndingOn('2026-01-28', 28)
const PAGE = '/blogs/guides/choosing-trail-shoes'

/**
 * Worked example 6: a blog post that moved from position 3.8 to 7.1 over three
 * months while its clicks fell from 1,700 to 860. Both windows come out of the
 * fixture — the earlier one is genuinely dated twelve weeks back, so the
 * comparison the detector makes is the comparison the example describes.
 */
describe('worked example 6 — decay', () => {
  const layer = rulesLayer()
  const config = layer.signals.content_decay
  const baselineWindow = shiftWeeks(WINDOW, config.comparison_window_offset_weeks)
  const rows = totalsInWindow(scenarioRows(6), WINDOW)
  const baselineRows = totalsInWindow(scenarioRows(6), baselineWindow)
  const pages = inventoryFor([...rows, ...baselineRows])

  function detect(priorWeeks: number) {
    return detectContentDecay({
      rows,
      baselineRows,
      pages,
      config,
      window: WINDOW,
      baselineWindow,
      priorConsecutiveEvaluations: new Map([[PAGE, priorWeeks]]),
      fetchedAt: FETCHED_AT,
    })
  }

  it('places the earlier window exactly twelve weeks back', () => {
    expect(baselineWindow).toEqual({
      startDate: '2025-10-09',
      endDate: '2025-11-05',
      days: 28,
    })
  })

  it('says nothing on the first sighting — one bad month is not a trend', () => {
    const result = detect(0)
    expect(result.detections).toHaveLength(0)
    expect(result.provisional.map((row) => row.page)).toEqual([PAGE])
    expect(result.provisional[0]?.consecutiveWeeklyEvaluations).toBe(1)
  })

  it('reports it once the decline has held across a second weekly run', () => {
    const found = detect(1).detections.find((row) => row.page === PAGE)
    expect(found).toBeDefined()
    expect(found?.confirmed).toBe(true)
    expect(found?.consecutiveWeeklyEvaluations).toBe(2)
    expect(found?.pageType).toBe('blog_article')
  })

  it('reproduces the example’s evidence numbers exactly', () => {
    const found = detect(1).detections.find((row) => row.page === PAGE)
    expect(found?.baselineClicks).toBe(1700)
    expect(found?.baselinePosition).toBeCloseTo(3.8, 10)
    expect(found?.currentClicks).toBe(860)
    expect(found?.currentPosition).toBeCloseTo(7.1, 10)
    expect(found?.clicksRatio).toBeCloseTo(860 / 1700, 12)
    expect(found?.positionWorsenedBy).toBeCloseTo(3.3, 10)
  })

  it('dates the "before" facts to the earlier window and the rest to this one', () => {
    const found = detect(1).detections.find((row) => row.page === PAGE)
    const byKey = new Map((found?.evidence ?? []).map((fact) => [fact.key, fact]))
    expect(byKey.get('clicks')?.window).toBe('28d')
    expect(byKey.get('baseline_clicks')?.window).toBe('28d_before_12w')
    expect(byKey.get('baseline_clicks')?.value).toBe(1700)
    for (const fact of found?.evidence ?? []) expect(fact.fetchedAt).toBe(FETCHED_AT)
  })

  it('names no action — a page can decay for a technical reason as easily as a stale one', () => {
    const found = detect(1).detections.find((row) => row.page === PAGE)
    expect(JSON.stringify(found)).not.toMatch(/OPTIMIZE|CREATE|REFRESH|HOLD|FIX/)
  })
})

describe('both halves have to have happened', () => {
  const config = rulesLayer().signals.content_decay
  const baselineWindow = shiftWeeks(WINDOW, config.comparison_window_offset_weeks)
  const pages = indexPages([
    { url: '/blogs/guides/a', pageType: 'blog_article', intentClass: null },
    { url: '/blogs/guides/b', pageType: 'blog_article', intentClass: null },
  ])
  const baselineRows = [
    { page: '/blogs/guides/a', query: 'garden shears', clicks: 1000, impressions: 20000, position: 4 },
    { page: '/blogs/guides/b', query: 'hedge trimmer', clicks: 900, impressions: 18000, position: 5 },
  ]

  function detect(now: { clicks: number; impressions: number; position: number }) {
    return detectContentDecay({
      rows: [
        { page: '/blogs/guides/a', query: 'garden shears', ...now },
        { page: '/blogs/guides/b', query: 'hedge trimmer', clicks: 900, impressions: 18000, position: 5 },
      ],
      baselineRows,
      pages,
      config,
      window: WINDOW,
      baselineWindow,
      priorConsecutiveEvaluations: new Map([['/blogs/guides/a', 1]]),
      fetchedAt: FETCHED_AT,
    }).detections.map((row) => row.page)
  }

  it('clicks collapsing while the position holds is not decay', () => {
    expect(detect({ clicks: 200, impressions: 20000, position: 4 })).toEqual([])
  })

  it('slipping several places while the clicks hold is not decay either', () => {
    expect(detect({ clicks: 950, impressions: 20000, position: 9 })).toEqual([])
  })

  it('both together is', () => {
    expect(detect({ clicks: 200, impressions: 12000, position: 9 })).toEqual(['/blogs/guides/a'])
  })
})

describe('a page that never worked', () => {
  it('has not decayed, whatever its numbers now say', () => {
    const config = rulesLayer().signals.content_decay
    const baselineWindow = shiftWeeks(WINDOW, config.comparison_window_offset_weeks)
    const result = detectContentDecay({
      rows: [
        { page: '/blogs/guides/a', query: 'garden shears', clicks: 1, impressions: 900, position: 20 },
        { page: '/blogs/guides/b', query: 'hedge trimmer', clicks: 800, impressions: 18000, position: 5 },
      ],
      // The middle page of this store earned hundreds of clicks; this one
      // earned five, so its collapse to one is not a loss worth recovering.
      baselineRows: [
        { page: '/blogs/guides/a', query: 'garden shears', clicks: 5, impressions: 1000, position: 12 },
        { page: '/blogs/guides/b', query: 'hedge trimmer', clicks: 900, impressions: 18000, position: 5 },
      ],
      pages: indexPages([
        { url: '/blogs/guides/a', pageType: 'blog_article', intentClass: null },
        { url: '/blogs/guides/b', pageType: 'blog_article', intentClass: null },
      ]),
      config,
      window: WINDOW,
      baselineWindow,
      priorConsecutiveEvaluations: new Map([['/blogs/guides/a', 5]]),
      fetchedAt: FETCHED_AT,
    })
    expect(result.detections.map((row) => row.page)).not.toContain('/blogs/guides/a')
  })
})

/** Guards the assumption the worked-example test rests on. */
describe('the fixture itself', () => {
  it('states example 6’s before-and-after', () => {
    expect(scenario(6).evidence).toContain('3.8 → 7.1')
    expect(scenario(6).evidence).toContain('1,700 → 860')
  })
})

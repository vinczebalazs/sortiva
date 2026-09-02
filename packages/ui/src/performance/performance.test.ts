import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { chartGeometry, measureTotal } from './chart'
import {
  clicksDelta,
  isUnmeasured,
  labelTone,
  positionDelta,
  resultFigure,
  resultLabel,
  signalBadges,
  splitResults,
} from './performance'
import { PerformanceChart } from './PerformanceChart'
import { PerformanceScreen } from './PerformanceScreen'
import { SearchConsoleTable } from './SearchConsoleTable'
import type { PerformanceDay, PerformanceResult, SearchConsoleRow } from './types'

/**
 * What this file holds the screen to.
 *
 * A day Search Console never reported has to stay a hole — in the geometry, in
 * the markup, and in the totals. A result inside the measurement window has to
 * read as early rather than as nought. An article published against our
 * recommendation has to sit outside the ordinary table. And every row that has
 * an open opportunity has to carry a link into it, because without that the
 * Search Console tab is a report nobody can act on.
 */

const DAYS: readonly PerformanceDay[] = [
  { date: '2026-08-01', clicks: 10, impressions: 400 },
  { date: '2026-08-02', clicks: 12, impressions: 460 },
  // Two days Search Console never sent.
  { date: '2026-08-03', clicks: null, impressions: null },
  { date: '2026-08-04', clicks: null, impressions: null },
  { date: '2026-08-05', clicks: 18, impressions: 700 },
  { date: '2026-08-06', clicks: 21, impressions: 810 },
]

const MARKERS = [
  { date: '2026-08-01', kind: 'gsc_connected' as const, label: 'connected' },
  { date: '2026-08-05', kind: 'article_published' as const, label: 'an article' },
  { date: '2026-08-06', kind: 'optimize_applied' as const, label: 'a collection' },
]

const article = (over: Partial<PerformanceResult> = {}): PerformanceResult => ({
  kind: 'article',
  id: 'article-1',
  title: 'Best trail shoes for wide feet',
  clicks: 412,
  impressions: 9140,
  position: 6.4,
  trend: 'up',
  label: 'winner',
  publishedViaOverride: false,
  ...over,
})

describe('a missing day is a hole, never a joined line', () => {
  const geometry = chartGeometry(DAYS, MARKERS, { width: 600, height: 100 })

  it('splits the line into runs either side of the gap', () => {
    const clicks = geometry.panels.find((panel) => panel.measure === 'clicks')!
    expect(clicks.runs).toHaveLength(2)
    expect(clicks.runs[0]!.points.map((point) => point.date)).toEqual(['2026-08-01', '2026-08-02'])
    expect(clicks.runs[1]!.points.map((point) => point.date)).toEqual(['2026-08-05', '2026-08-06'])
  })

  it('counts the days it has no figure for rather than filling them', () => {
    expect(geometry.panels[0]!.missingDays).toBe(2)
  })

  it('never emits a path segment that spans the gap', () => {
    const clicks = geometry.panels.find((panel) => panel.measure === 'clicks')!
    for (const run of clicks.runs) {
      // A run's own path starts with a move; a joined line would show one path
      // holding every point including the two either side of the hole.
      expect(run.path.startsWith('M')).toBe(true)
      expect(run.points.length).toBeLessThan(DAYS.length)
    }
  })

  it('totals only the days that reported, and says how many did not', () => {
    expect(measureTotal(DAYS, 'clicks')).toEqual({ total: 61, missingDays: 2 })
  })
})

describe('clicks and impressions are two panels, never two lines on one scale', () => {
  const geometry = chartGeometry(DAYS, MARKERS, { width: 600, height: 100 })

  it('scales each measure against its own maximum', () => {
    const [clicks, impressions] = geometry.panels
    expect(clicks!.measure).toBe('clicks')
    expect(impressions!.measure).toBe('impressions')
    expect(clicks!.max).toBeLessThan(impressions!.max)
  })
})

describe('the markers', () => {
  it('places one of each kind the card asks for', () => {
    const html = renderToStaticMarkup(
      createElement(PerformanceChart, { series: DAYS, markers: MARKERS }),
    )
    for (const kind of ['gsc_connected', 'article_published', 'optimize_applied']) {
      expect(html, kind).toContain(`data-perf-marker="${kind}"`)
      expect(html, kind).toContain(`data-perf-marker-label="${kind}"`)
    }
  })

  it('drops a marker dated outside the range rather than pinning it to an edge', () => {
    const geometry = chartGeometry(
      DAYS,
      [{ date: '2025-01-01', kind: 'article_published', label: 'long before' }],
      { width: 600, height: 100 },
    )
    expect(geometry.markers).toEqual([])
  })
})

describe('the chart says the data is late and where it is missing', () => {
  const html = renderToStaticMarkup(
    createElement(PerformanceChart, { series: DAYS, markers: MARKERS }),
  )

  it('carries the lag note', () => {
    expect(html).toContain('data-perf-lag-note')
    expect(html).toContain('Search Console data arrives with ~2 days delay.')
  })

  it('says the gaps are gaps and are not filled in', () => {
    expect(html).toContain('never filled in')
  })

  it('offers the same figures as a table, with the missing days shown as missing', () => {
    expect(html).toContain('data-perf-chart-table')
    expect(html).toContain('data-perf-day="2026-08-03"')
  })
})

describe('a result inside the measurement window reads as early, not as nought', () => {
  it('has no figures at all', () => {
    const young = article({ label: 'unrated', clicks: 0, impressions: 0, position: 0 })
    expect(resultFigure(young, 'clicks')).toBeNull()
    expect(resultFigure(young, 'impressions')).toBeNull()
    expect(resultFigure(young, 'position')).toBeNull()
  })

  it('is worded as waiting rather than as a verdict', () => {
    expect(resultLabel('unrated')).toBe('too new to judge — we wait 28 days')
    expect(labelTone('unrated')).toBe('unmeasured')
    expect(isUnmeasured('unrated')).toBe(true)
  })

  it('renders a dash where a rated row renders a number', () => {
    const html = renderToStaticMarkup(
      createElement(PerformanceScreen, {
        data: {
          connected: true,
          series: DAYS,
          markers: MARKERS,
          results: [article(), article({ id: 'article-2', label: 'unrated' })],
        },
      }),
    )
    expect(html).toContain('data-perf-result-measured="false"')
    expect(html).toContain('data-perf-result-measured="true"')
    // The young row's clicks cell is an em dash, and nowhere on the page does a
    // young article show a nought.
    const youngRow = html.slice(html.indexOf('data-perf-result="article-2"'))
    expect(youngRow.slice(0, 400)).toContain('—')
    expect(youngRow.slice(0, 400)).not.toContain('>0<')
  })

  it('keeps unrated rows out of the label breakdown', () => {
    const html = renderToStaticMarkup(
      createElement(PerformanceScreen, {
        data: {
          connected: true,
          series: DAYS,
          markers: MARKERS,
          results: [article(), article({ id: 'article-2', label: 'unrated' })],
        },
      }),
    )
    expect(html).toContain('data-perf-label-count="winner"')
    expect(html).not.toContain('data-perf-label-count="unrated"')
  })

  it('says the verdicts are relative to this store rather than absolute', () => {
    const html = renderToStaticMarkup(
      createElement(PerformanceScreen, {
        data: { connected: true, series: DAYS, markers: MARKERS, results: [article()] },
      }),
    )
    expect(html).toContain('data-perf-relative-note')
    expect(html).toContain('your own store')
  })
})

describe('articles published against our recommendation', () => {
  const results = [article(), article({ id: 'article-2', publishedViaOverride: true })]

  it('are held apart from the rest', () => {
    const split = splitResults(results)
    expect(split.rows.map((row) => row.id)).toEqual(['article-1'])
    expect(split.overridden.map((row) => row.id)).toEqual(['article-2'])
  })

  it('render inside a folded-away section that says why they are separate', () => {
    const html = renderToStaticMarkup(
      createElement(PerformanceScreen, {
        data: { connected: true, series: DAYS, markers: MARKERS, results },
      }),
    )
    expect(html).toContain('data-perf-overridden')
    const section = html.slice(html.indexOf('data-perf-overridden'))
    expect(section).toContain('<summary>')
    expect(section).toContain('Published against recommendation')
    expect(section).toContain('kept out of quality tuning')
    expect(section).toContain('data-perf-result="article-2"')
  })

  it('do not appear in the ordinary results table', () => {
    const html = renderToStaticMarkup(
      createElement(PerformanceScreen, {
        data: { connected: true, series: DAYS, markers: MARKERS, results },
      }),
    )
    const before = html.slice(0, html.indexOf('data-perf-overridden'))
    expect(before).not.toContain('data-perf-result="article-2"')
  })
})

describe('a store with no Search Console connection', () => {
  it('gets the canonical connect sentence and nothing else', () => {
    const html = renderToStaticMarkup(
      createElement(PerformanceScreen, {
        data: { connected: false, series: [], markers: [], results: [] },
      }),
    )
    expect(html).toContain('Connect Google Search Console to unlock full Growth Intelligence')
    expect(html).toContain('data-perf-connect')
    expect(html).not.toContain('data-perf-chart="drawn"')
  })
})

describe('the Search Console rows carry a way into the opportunity', () => {
  const row: SearchConsoleRow = {
    key: 'trail running shoes for wide feet',
    clicks: 204,
    impressions: 8400,
    ctr: 0.024,
    position: 8.6,
    deltaClicks: 18,
    deltaPosition: -0.4,
    pageType: null,
    signals: [
      { signalType: 'striking_distance', opportunityId: '11111111-1111-4111-8111-111111111111' },
    ],
  }

  it('points each badge at the opportunity it came from', () => {
    expect(signalBadges(row)).toEqual([
      {
        signalType: 'striking_distance',
        opportunityId: '11111111-1111-4111-8111-111111111111',
        href: '/opportunities#11111111-1111-4111-8111-111111111111',
      },
    ])
  })

  it('renders the badge as a link with the signal named in words', () => {
    const html = renderToStaticMarkup(
      createElement(SearchConsoleTable, { rows: [row], dimension: 'query' }),
    )
    expect(html).toContain('href="/opportunities#11111111-1111-4111-8111-111111111111"')
    expect(html).toContain('data-sc-signal="striking_distance"')
    expect(html).not.toContain('striking_distance<')
  })

  it('shows an absence rather than an empty badge where there is no opportunity', () => {
    const html = renderToStaticMarkup(
      createElement(SearchConsoleTable, {
        rows: [{ ...row, signals: [] }],
        dimension: 'query',
      }),
    )
    expect(html).not.toContain('data-sc-signal=')
    expect(html).toContain('sortiva-perf__no-signal')
  })

  it('names the page type on the pages table', () => {
    const html = renderToStaticMarkup(
      createElement(SearchConsoleTable, {
        rows: [{ ...row, key: '/collections/trail', pageType: 'collection' }],
        dimension: 'page',
      }),
    )
    expect(html).toContain('data-sc-page-type="collection"')
    expect(html).toContain('Collection')
  })
})

describe('a change in position is read by what it means, not by its sign', () => {
  it('calls a fall in the number an improvement', () => {
    const delta = positionDelta(-4)
    expect(delta.direction).toBe('up')
    expect(delta.favourable).toBe(true)
    expect(delta.text).toContain('up 4')
  })

  it('calls a rise in the number a decline', () => {
    expect(positionDelta(3.2).favourable).toBe(false)
  })

  it('reads a change in clicks the obvious way', () => {
    expect(clicksDelta(18).favourable).toBe(true)
    expect(clicksDelta(-18).favourable).toBe(false)
    expect(clicksDelta(0).direction).toBe('flat')
  })
})

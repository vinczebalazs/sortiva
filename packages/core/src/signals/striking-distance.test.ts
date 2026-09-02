import { describe, expect, it } from 'vitest'
import { configPath, loadRulesConfig } from '@sortiva/rules'
import { readFileSync } from 'node:fs'
import { scenario } from '../fixtures'
import { detectStrikingDistance } from './striking-distance'
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

function detectFor(id: number) {
  const rows = totalsInWindow(scenarioRows(id), WINDOW)
  return detectStrikingDistance({
    clusters: clustersFrom(rows),
    rows,
    pages: inventoryFor(rows),
    config: rulesLayer().signals.striking_distance,
    window: WINDOW,
    fetchedAt: FETCHED_AT,
  })
}

/**
 * Worked example 1 from the spec: the query "best trail running shoes", the
 * collection `/collections/trail-running`, position 7.3, 9,402 impressions over
 * 28 days. The numbers below are that example's, not numbers chosen here.
 */
describe('worked example 1 — striking distance', () => {
  const result = detectFor(1)
  const found = result.detections.find(
    (row) => row.page === '/collections/trail-running',
  )

  it('detects the example on the page the example names', () => {
    expect(found).toBeDefined()
    expect(found?.signalType).toBe('striking_distance')
    expect(found?.pageType).toBe('collection')
  })

  it('reproduces the example’s evidence numbers exactly', () => {
    expect(found?.clusterHead).toBe('best trail running shoes')
    expect(found?.position).toBeCloseTo(7.3, 10)
    expect(found?.clusterImpressions).toBe(9402)
    expect(found?.clusterClicks).toBe(210)
  })

  it('carries every fact with its source and window', () => {
    for (const fact of found?.evidence ?? []) {
      expect(fact.fetchedAt).toBe(FETCHED_AT)
      expect(fact.source.length).toBeGreaterThan(0)
    }
    const byKey = new Map((found?.evidence ?? []).map((fact) => [fact.key, fact]))
    expect(byKey.get('impressions')?.value).toBe(9402)
    expect(byKey.get('impressions')?.window).toBe('28d')
    expect(byKey.get('impressions')?.source).toBe('gsc')
    expect(byKey.get('page_type')?.source).toBe('content_inventory')
  })

  it('names no action — that decision is taken later, against the whole picture', () => {
    expect(Object.keys(found ?? {})).not.toContain('recommendedAction')
    expect(JSON.stringify(found)).not.toMatch(/OPTIMIZE|CREATE|REFRESH|HOLD/)
  })
})

describe('the band', () => {
  const config = rulesLayer().signals.striking_distance
  const pages = indexPages([{ url: '/collections/a', pageType: 'collection', intentClass: null }])
  const clusters = [{ headQuery: 'garden shears', memberQueries: [] }]

  function atPosition(position: number) {
    return detectStrikingDistance({
      clusters,
      rows: [
        { page: '/collections/a', query: 'garden shears', clicks: 10, impressions: 5000, position },
      ],
      pages,
      config,
      window: WINDOW,
      fetchedAt: FETCHED_AT,
    }).detections
  }

  it('ignores a page already at the top, where editing has nothing left to win', () => {
    expect(atPosition(2)).toHaveLength(0)
  })

  it('ignores a page too far back for an edit to reach', () => {
    expect(atPosition(22)).toHaveLength(0)
  })

  it('takes a page inside the band', () => {
    expect(atPosition(7)).toHaveLength(1)
  })
})

describe('the traffic floor', () => {
  const config = rulesLayer().signals.striking_distance
  const pages = indexPages([
    { url: '/collections/quiet', pageType: 'collection', intentClass: null },
    { url: '/collections/busy-1', pageType: 'collection', intentClass: null },
    { url: '/collections/busy-2', pageType: 'collection', intentClass: null },
  ])

  it('skips a page below the store’s middle, however good its position', () => {
    const result = detectStrikingDistance({
      clusters: [{ headQuery: 'garden shears', memberQueries: [] }],
      rows: [
        { page: '/collections/quiet', query: 'garden shears', clicks: 1, impressions: 40, position: 6 },
        { page: '/collections/busy-1', query: 'garden shears', clicks: 90, impressions: 9000, position: 6 },
        { page: '/collections/busy-2', query: 'garden shears', clicks: 80, impressions: 8000, position: 6 },
      ],
      pages,
      config,
      window: WINDOW,
      fetchedAt: FETCHED_AT,
    })
    expect(result.detections.map((row) => row.page)).toEqual([
      '/collections/busy-1',
      '/collections/busy-2',
    ])
  })
})

describe('one piece of work per page', () => {
  it('keeps the busiest intent and counts the rest', () => {
    const pages = indexPages([
      { url: '/collections/a', pageType: 'collection', intentClass: null },
    ])
    const result = detectStrikingDistance({
      clusters: [
        { headQuery: 'garden shears', memberQueries: [] },
        { headQuery: 'hedge trimmer', memberQueries: [] },
      ],
      rows: [
        { page: '/collections/a', query: 'garden shears', clicks: 10, impressions: 4000, position: 6 },
        { page: '/collections/a', query: 'hedge trimmer', clicks: 8, impressions: 6000, position: 9 },
      ],
      pages,
      config: rulesLayer().signals.striking_distance,
      window: WINDOW,
      fetchedAt: FETCHED_AT,
    })
    expect(result.detections).toHaveLength(1)
    expect(result.detections[0]?.clusterHead).toBe('hedge trimmer')
    expect(result.detections[0]?.otherQualifyingClusters).toBe(1)
  })
})

describe('pages Search Console reports that the inventory does not hold', () => {
  it('are reported rather than silently dropped', () => {
    const result = detectStrikingDistance({
      clusters: [{ headQuery: 'garden shears', memberQueries: [] }],
      rows: [
        { page: '/collections/known', query: 'garden shears', clicks: 10, impressions: 5000, position: 6 },
        { page: '/collections/unknown', query: 'garden shears', clicks: 4, impressions: 900, position: 6 },
      ],
      pages: indexPages([
        { url: '/collections/known', pageType: 'collection', intentClass: null },
      ]),
      config: rulesLayer().signals.striking_distance,
      window: WINDOW,
      fetchedAt: FETCHED_AT,
    })
    expect(result.unknownPages).toEqual(['/collections/unknown'])
    expect(result.detections.map((row) => row.page)).toEqual(['/collections/known'])
  })
})

/**
 * The done-when for this card: moving a band in `signals.config.yaml` has to
 * move what is detected. If it did not, the numbers in the file would be
 * decoration and the real ones would be somewhere in the code.
 */
describe('the config file is the only thing deciding the band', () => {
  it('stops detecting the same page when the band is narrowed in the YAML', () => {
    const source = readFileSync(configPath(), 'utf8')
    const narrowed = source.replace('position_min: 4\n      position_max: 15', 'position_min: 4\n      position_max: 6')
    expect(narrowed).not.toBe(source)

    const shared = {
      clusters: [{ headQuery: 'garden shears', memberQueries: [] }],
      rows: [
        { page: '/collections/a', query: 'garden shears', clicks: 10, impressions: 5000, position: 9 },
      ],
      pages: indexPages([{ url: '/collections/a', pageType: 'collection', intentClass: null }]),
      window: WINDOW,
      fetchedAt: FETCHED_AT,
    }

    const before = loadRulesConfig({ source }).defaults.signals.striking_distance
    const after = loadRulesConfig({ source: narrowed }).defaults.signals.striking_distance

    expect(detectStrikingDistance({ ...shared, config: before }).detections).toHaveLength(1)
    expect(detectStrikingDistance({ ...shared, config: after }).detections).toHaveLength(0)
  })
})

/** Guards the assumption the worked-example tests rest on: the fixture is what the spec says it is. */
describe('the fixture itself', () => {
  it('states example 1’s evidence', () => {
    expect(scenario(1).evidence).toContain('position 7.3')
    expect(scenario(1).evidence).toContain('9,402 impressions')
  })
})

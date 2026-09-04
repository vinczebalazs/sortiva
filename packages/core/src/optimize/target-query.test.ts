import { describe, expect, it } from 'vitest'
import { resolveTargetQueryFromClusters, targetQueryFromEvidence } from './target-query'

/**
 * The one rule this file exists to hold: a page with no search of its own gets
 * a real search from the store's pooled intents, or it gets nothing. It never
 * gets its own web address, and nothing here derives a search from the words in
 * one.
 */

const PAGE = 'https://shop.example/collections/hiking-boots'
const OTHER = 'https://shop.example/collections/socks'

const CLUSTERS = [
  { headQuery: 'waterproof hiking boots', memberQueries: ['hiking boots waterproof'] },
  { headQuery: 'wide fit walking boots', memberQueries: [] },
]

function row(page: string, query: string, impressions: number) {
  return { page, query, clicks: 0, impressions, position: 8 }
}

describe('the search a detection recorded', () => {
  it('is read from whichever key the detection used', () => {
    expect(targetQueryFromEvidence([{ key: 'query_cluster', value: 'trail shoes' }])).toBe(
      'trail shoes',
    )
    expect(targetQueryFromEvidence([{ key: 'keyword', value: 'trail shoes' }])).toBe('trail shoes')
  })

  it('prefers the pooled intent over a single spelling when both are recorded', () => {
    expect(
      targetQueryFromEvidence([
        { key: 'query', value: 'boots waterproof' },
        { key: 'query_cluster', value: 'waterproof boots' },
      ]),
    ).toBe('waterproof boots')
  })

  it('is null — never the evidence itself — when the detection recorded no search', () => {
    expect(
      targetQueryFromEvidence([
        { key: 'missing_fields', value: 'seo_title,seo_description' },
        { key: 'page_type', value: 'collection' },
      ]),
    ).toBeNull()
    expect(targetQueryFromEvidence([{ key: 'query', value: '   ' }])).toBeNull()
    expect(targetQueryFromEvidence(null)).toBeNull()
    expect(targetQueryFromEvidence({ query: 'not an array' })).toBeNull()
  })
})

describe('resolving a search from the store’s own intents', () => {
  it('picks the intent the page is shown for most', () => {
    const resolved = resolveTargetQueryFromClusters({
      pageUrl: PAGE,
      clusters: CLUSTERS,
      rows: [
        row(PAGE, 'wide fit walking boots', 40),
        row(PAGE, 'waterproof hiking boots', 90),
        row(PAGE, 'hiking boots waterproof', 30),
      ],
    })

    expect(resolved).toBe('waterproof hiking boots')
  })

  it('counts only this page, never another page’s share of the same intent', () => {
    const resolved = resolveTargetQueryFromClusters({
      pageUrl: PAGE,
      clusters: CLUSTERS,
      rows: [
        row(OTHER, 'waterproof hiking boots', 5000),
        row(PAGE, 'wide fit walking boots', 20),
      ],
    })

    expect(resolved).toBe('wide fit walking boots')
  })

  it('matches the page across the address spellings the rest of the product treats as one', () => {
    const resolved = resolveTargetQueryFromClusters({
      pageUrl: PAGE,
      clusters: CLUSTERS,
      rows: [row(`${PAGE}/#reviews`, 'waterproof hiking boots', 12)],
    })

    expect(resolved).toBe('waterproof hiking boots')
  })

  it('returns nothing when no intent of the store’s covers this page', () => {
    expect(
      resolveTargetQueryFromClusters({
        pageUrl: PAGE,
        clusters: CLUSTERS,
        rows: [row(OTHER, 'waterproof hiking boots', 900)],
      }),
    ).toBeNull()

    expect(
      resolveTargetQueryFromClusters({
        pageUrl: PAGE,
        clusters: CLUSTERS,
        rows: [row(PAGE, 'something nobody pooled', 900)],
      }),
    ).toBeNull()
  })

  it('returns nothing rather than anything resembling the address, for a store with no intents at all', () => {
    const resolved = resolveTargetQueryFromClusters({
      pageUrl: PAGE,
      clusters: [],
      rows: [row(PAGE, 'hiking boots', 900)],
    })

    expect(resolved).toBeNull()
  })

  it('settles a tie the same way every run', () => {
    const clusters = [
      { headQuery: 'walking boots', memberQueries: [] },
      { headQuery: 'hiking boots', memberQueries: [] },
    ]
    const rows = [row(PAGE, 'walking boots', 50), row(PAGE, 'hiking boots', 50)]

    expect(resolveTargetQueryFromClusters({ pageUrl: PAGE, clusters, rows })).toBe('hiking boots')
    expect(
      resolveTargetQueryFromClusters({ pageUrl: PAGE, clusters: [...clusters].reverse(), rows }),
    ).toBe('hiking boots')
  })
})

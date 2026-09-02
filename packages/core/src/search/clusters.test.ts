import { describe, expect, it } from 'vitest'
import { rules } from '@sortiva/rules'
import {
  buildQueryClusters,
  clusterKeyFor,
  contentTokens,
  normaliseQuery,
  type ClusterQueryInput,
} from './clusters'
import { pageClusterShares, type ClusterShareRow } from './shares'

const config = rules().defaults.clusters

function q(query: string, impressions: number, clicks = 0): ClusterQueryInput {
  return { query, impressions, clicks }
}

describe('pooling phrasings into one intent', () => {
  it('pools the variants of a search under the phrasing the store is shown for most', () => {
    const clusters = buildQueryClusters({
      config,
      queries: [
        q('waterproof hiking boots', config.head_min_impressions * 4, 40),
        q('hiking boots waterproof', config.head_min_impressions - 1, 10),
        q('best waterproof hiking boots', config.head_min_impressions - 30, 8),
        q('waterproof hiking boots for wide feet', config.head_min_impressions - 60, 2),
      ],
    })

    expect(clusters).toHaveLength(1)
    const [cluster] = clusters
    expect(cluster?.headQuery).toBe('waterproof hiking boots')
    expect(cluster?.memberQueries).toEqual([
      'hiking boots waterproof',
      'best waterproof hiking boots',
      'waterproof hiking boots for wide feet',
    ])
    // Every search's impressions and clicks are inside the cluster's totals —
    // which is the whole reason for pooling: alone, none of these is worth an
    // opportunity; together they are.
    expect(cluster?.impressions).toBe(
      config.head_min_impressions * 4 +
        (config.head_min_impressions - 1) +
        (config.head_min_impressions - 30) +
        (config.head_min_impressions - 60),
    )
    expect(cluster?.clicks).toBe(60)
  })

  it('never pools two searches that are not about the same thing', () => {
    const clusters = buildQueryClusters({
      config,
      queries: [q('running shoes', 800), q('dress shoes', 700), q('shoe polish', 600)],
    })
    expect(clusters.map((c) => c.headQuery).sort()).toEqual(['dress shoes', 'running shoes', 'shoe polish'])
    for (const cluster of clusters) expect(cluster.memberQueries).toEqual([])
  })

  it('gives a narrower head first refusal, so a broad one cannot swallow it', () => {
    // "shoes" alone would otherwise take "trail running shoes" with it, and
    // every conclusion drawn from that cluster would be about nothing in
    // particular. "running shoes" is shown often enough to stand as its own
    // intent; the two rarer searches are not, so each folds into the most
    // specific cluster that contains it.
    const big = config.head_min_impressions * 10
    const standalone = config.head_min_impressions
    const rare = config.head_min_impressions - 1
    const clusters = buildQueryClusters({
      config: { ...config, head_min_tokens: 1 },
      queries: [q('shoes', big), q('running shoes', standalone), q('trail running shoes', rare), q('shoes uk', rare)],
    })

    const byHead = new Map(clusters.map((c) => [c.headQuery, c.memberQueries]))
    expect(byHead.get('running shoes')).toEqual(['trail running shoes'])
    expect(byHead.get('shoes')).toEqual(['shoes uk'])
  })

  it('folds a rare narrower search in, and lets a busy one stand alone — the line is the config', () => {
    const build = (impressions: number) =>
      buildQueryClusters({
        config,
        queries: [q('garden shears', config.head_min_impressions * 20), q('electric garden shears', impressions)],
      })

    const folded = build(config.head_min_impressions - 1)
    expect(folded).toHaveLength(1)
    expect(folded[0]?.memberQueries).toEqual(['electric garden shears'])

    const separate = build(config.head_min_impressions)
    expect(separate).toHaveLength(2)
    expect(separate.map((c) => c.headQuery).sort()).toEqual(['electric garden shears', 'garden shears'])
  })

  it('the same words in another order fold in however busy they are', () => {
    // "best linen bedding" carries the head's words and one filler. Splitting it
    // off would have the store competing with itself on the strength of "best".
    const clusters = buildQueryClusters({
      config,
      queries: [
        q('linen bedding', config.head_min_impressions * 10),
        q('best linen bedding', config.head_min_impressions * 5),
      ],
    })
    expect(clusters).toHaveLength(1)
    expect(clusters[0]?.memberQueries).toEqual(['best linen bedding'])
  })

  it('ignores word order and the words that carry no intent', () => {
    expect(contentTokens('shoes for running').sort()).toEqual(['running', 'shoes'])
    expect(normaliseQuery('  Best  Running-Shoes!  ')).toBe('best running shoes')

    const clusters = buildQueryClusters({
      config,
      queries: [q('running shoes', config.head_min_impressions * 4), q('shoes for running', config.head_min_impressions - 1)],
    })
    expect(clusters).toHaveLength(1)
    expect(clusters[0]?.memberQueries).toEqual(['shoes for running'])
  })

  it('leaves out searches shown too rarely to mean anything', () => {
    const clusters = buildQueryClusters({
      config,
      queries: [
        q('garden shears', 500),
        q('garden shears left handed', config.min_query_impressions),
        q('garden shears for roses', config.min_query_impressions - 1),
      ],
    })
    expect(clusters[0]?.memberQueries).toEqual(['garden shears left handed'])
  })

  it('refuses to make a head out of a search too broad to be one', () => {
    // With the configured minimum of two words, "boots" cannot become a head at
    // all — so it forms no cluster rather than a meaningless one.
    const clusters = buildQueryClusters({ config, queries: [q('boots', 9_000)] })
    expect(clusters).toEqual([])
  })

  it('prefers a search the merchant confirmed as the head, even when another is shown more', () => {
    const clusters = buildQueryClusters({
      config,
      queries: [
        q('best garden shears', config.head_min_impressions * 4),
        q('garden shears', config.head_min_impressions - 1),
      ],
      preferredHeads: ['garden shears'],
    })
    // Shown four times as often, "best garden shears" would otherwise name this
    // cluster. The merchant confirmed the plain term, so that is what they see.
    expect(clusters[0]?.headQuery).toBe('garden shears')
    expect(clusters[0]?.memberQueries).toEqual(['best garden shears'])
  })

  it('holds to the configured ceilings on cluster and member counts', () => {
    const queries = Array.from({ length: 30 }, (_, i) => q(`topic ${i} guide`, 1_000 - i))
    const capped = buildQueryClusters({ config: { ...config, max_clusters: 5 }, queries })
    expect(capped).toHaveLength(5)

    const many = [
      q('garden shears', config.head_min_impressions * 40),
      ...Array.from({ length: 10 }, (_, i) => q(`garden shears type ${i}`, config.head_min_impressions - 1 - i)),
    ]
    const cappedMembers = buildQueryClusters({ config: { ...config, max_member_queries: 3 }, queries: many })
    expect(cappedMembers[0]?.memberQueries).toHaveLength(3)
  })
})

describe('the lineage a cluster carries', () => {
  it('records the head it descended from and every phrasing folded into it', () => {
    // T3.3 done-when: "clusters carry lineage". A topic written from this
    // cluster later points back at it, and this is what makes "which search did
    // this article come from" answerable a year afterwards.
    const [cluster] = buildQueryClusters({
      config,
      queries: [
        q('linen bedding', config.head_min_impressions * 8),
        q('best linen bedding', config.head_min_impressions - 1),
        q('linen bedding sets', config.head_min_impressions - 50),
      ],
    })

    expect(cluster?.headQuery).toBe('linen bedding')
    expect(cluster?.memberQueries).toEqual(['best linen bedding', 'linen bedding sets'])
    // The head is not repeated inside its own members: the lineage object is
    // "this head, plus these", and a duplicated head would double-count its
    // impressions in anything that walks the members.
    expect(cluster?.memberQueries).not.toContain('linen bedding')
  })

  it('finds the cluster a single search descended from', () => {
    const clusters = buildQueryClusters({
      config,
      queries: [q('linen bedding', config.head_min_impressions * 8), q('best linen bedding', config.head_min_impressions - 1)],
    })
    expect(clusterKeyFor('Best Linen Bedding', clusters)).toBe('linen bedding')
    expect(clusterKeyFor('linen bedding', clusters)).toBe('linen bedding')
    expect(clusterKeyFor('wool blankets', clusters)).toBeNull()
  })

  it('assigns every eligible search to exactly one cluster', () => {
    const queries = [
      q('linen bedding', config.head_min_impressions * 8),
      q('best linen bedding', config.head_min_impressions - 1),
      q('linen bedding sets', config.head_min_impressions - 50),
      q('wool blankets', config.head_min_impressions * 2),
      q('soft wool blankets', config.head_min_impressions - 100),
    ]
    const clusters = buildQueryClusters({ config, queries })
    const seen = clusters.flatMap((c) => [c.headQuery, ...c.memberQueries])
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.sort()).toEqual(queries.map((row) => row.query).sort())
  })
})

describe('how much of an intent each page holds', () => {
  const clusters = [{ headQuery: 'linen bedding', memberQueries: ['best linen bedding'] }]

  function row(page: string, query: string, impressions: number, position: number, clicks = 0): ClusterShareRow {
    return { page, query, impressions, position, clicks }
  }

  it('splits an intent across the pages Google shows for it', () => {
    const [shares] = pageClusterShares(clusters, [
      row('https://s.example/collections/linen', 'linen bedding', 700, 6, 30),
      row('https://s.example/collections/linen', 'best linen bedding', 100, 8, 4),
      row('https://s.example/blogs/news/linen-guide', 'linen bedding', 200, 12, 5),
    ])

    expect(shares?.impressions).toBe(1_000)
    expect(shares?.clicks).toBe(39)
    expect(shares?.pages.map((p) => p.impressionShare)).toEqual([0.8, 0.2])
    // Two of the store's own pages, each holding a real slice of one intent —
    // the shape the cannibalization detector looks for.
    expect(shares?.pages).toHaveLength(2)
  })

  it('weights average position by how often the page was actually shown', () => {
    // Averaging the two positions would give 7. Weighted by impressions it is
    // much closer to the position that nearly all the impressions sat at.
    const [shares] = pageClusterShares(clusters, [
      row('https://s.example/a', 'linen bedding', 9_900, 4),
      row('https://s.example/a', 'best linen bedding', 100, 10),
    ])
    expect(shares?.pages[0]?.position).toBeCloseTo(4.06, 2)
  })

  it('says nothing rather than "position one" when a page was never shown', () => {
    const [shares] = pageClusterShares(clusters, [
      { page: 'https://s.example/a', query: 'linen bedding', impressions: 0, clicks: 0, position: null },
    ])
    expect(shares?.pages[0]?.position).toBeNull()
    expect(shares?.pages[0]?.impressionShare).toBe(0)
  })

  it('ignores searches that belong to no cluster', () => {
    const [shares] = pageClusterShares(clusters, [
      row('https://s.example/a', 'linen bedding', 500, 5),
      row('https://s.example/b', 'wool blankets', 5_000, 2),
    ])
    expect(shares?.impressions).toBe(500)
    expect(shares?.pages).toHaveLength(1)
  })

  it('shares within a cluster add up to the whole of it', () => {
    const [shares] = pageClusterShares(clusters, [
      row('https://s.example/a', 'linen bedding', 333, 5),
      row('https://s.example/b', 'linen bedding', 333, 9),
      row('https://s.example/c', 'best linen bedding', 334, 14),
    ])
    const total = (shares?.pages ?? []).reduce((sum, page) => sum + page.impressionShare, 0)
    expect(total).toBeCloseTo(1, 10)
  })

  it('carries the stored cluster id through when there is one', () => {
    const [shares] = pageClusterShares(
      [{ headQuery: 'linen bedding', memberQueries: [], clusterId: 'c-1' }],
      [row('https://s.example/a', 'linen bedding', 10, 3)],
    )
    expect(shares?.clusterId).toBe('c-1')
  })
})

import { describe, expect, it } from 'vitest'
import type { EvidenceFact } from '../contracts/opportunities'
import {
  NoCompetingPagesError,
  buildConsolidationRecommendation,
  consolidationInputFromEvidence,
  type CompetingPageFacts,
} from './consolidation'

function page(overrides: Partial<CompetingPageFacts> & { url: string }): CompetingPageFacts {
  return {
    pageType: 'collection',
    impressionShare: 0.3,
    position: 9,
    ...overrides,
  }
}

describe('choosing which page should answer the search', () => {
  it('prefers the page Google already shows most often', () => {
    const result = buildConsolidationRecommendation({
      clusterHead: 'trail shoes',
      competing: [
        page({ url: '/a', impressionShare: 0.3, position: 4 }),
        page({ url: '/b', impressionShare: 0.6, position: 11 }),
      ],
    })
    expect(result.primary.url).toBe('/b')
    expect(result.primaryReasonTemplateKey).toBe('fix.consolidation.primary.mostShown')
    expect(result.primaryReasonParams.sharePercent).toBe(60)
  })

  it('falls to the better average position when the store is shown equally often', () => {
    const result = buildConsolidationRecommendation({
      clusterHead: 'trail shoes',
      competing: [
        page({ url: '/a', impressionShare: 0.4, position: 12 }),
        page({ url: '/b', impressionShare: 0.4, position: 6.4 }),
      ],
    })
    expect(result.primary.url).toBe('/b')
    expect(result.primaryReasonTemplateKey).toBe('fix.consolidation.primary.bestPosition')
    expect(result.primaryReasonParams.position).toBe(6.4)
  })

  it('falls to the page that led in the most weeks when both other measures tie', () => {
    const result = buildConsolidationRecommendation({
      clusterHead: 'trail shoes',
      competing: [page({ url: '/a' }), page({ url: '/b' })],
      weeklyLeaders: [{ page: '/b' }, { page: '/b' }, { page: '/a' }],
    })
    expect(result.primary.url).toBe('/b')
    expect(result.primaryReasonTemplateKey).toBe('fix.consolidation.primary.ledMostWeeks')
    expect(result.primaryReasonParams.weeks).toBe(2)
  })

  it('gives the same answer whatever order the pages arrive in', () => {
    const pages = [
      page({ url: '/a', impressionShare: 0.4, position: 9 }),
      page({ url: '/b', impressionShare: 0.4, position: 9 }),
      page({ url: '/c', impressionShare: 0.2, position: 3 }),
    ]
    const first = buildConsolidationRecommendation({ clusterHead: 'q', competing: pages })
    const reversed = buildConsolidationRecommendation({
      clusterHead: 'q',
      competing: [...pages].reverse(),
    })
    expect(first.primary.url).toBe('/a')
    expect(reversed.primary.url).toBe(first.primary.url)
    expect(reversed.secondary.map((p) => p.url)).toEqual(first.secondary.map((p) => p.url))
  })

  it('refuses to invent a recommendation out of nothing', () => {
    expect(() => buildConsolidationRecommendation({ clusterHead: 'q', competing: [] })).toThrow(
      NoCompetingPagesError,
    )
  })
})

describe('the canonical suggestion, which is the part that can do harm', () => {
  it('suggests one only between pages of the same kind', () => {
    const result = buildConsolidationRecommendation({
      clusterHead: 'trail shoes',
      competing: [
        page({ url: '/collections/a', pageType: 'collection', impressionShare: 0.5 }),
        page({ url: '/collections/b', pageType: 'collection', impressionShare: 0.3 }),
        page({ url: '/products/c', pageType: 'product', impressionShare: 0.2 }),
      ],
    })
    expect(result.canonicalSuggestions).toEqual([
      { url: '/collections/b', suggestedCanonicalTarget: '/collections/a' },
    ])
    expect(result.canonicalNotAdvisedFor).toEqual(['/products/c'])
  })

  it('never points a product page away from itself, however badly it is cannibalizing', () => {
    const result = buildConsolidationRecommendation({
      clusterHead: 'trail shoes',
      competing: [
        page({ url: '/collections/a', pageType: 'collection', impressionShare: 0.9 }),
        page({ url: '/products/c', pageType: 'product', impressionShare: 0.1 }),
      ],
    })
    expect(result.canonicalSuggestions).toEqual([])
    expect(result.canonicalNotAdvisedFor).toEqual(['/products/c'])
  })
})

describe('the links to realign', () => {
  it('names each link into a demoted page, and leaves every other link alone', () => {
    const result = buildConsolidationRecommendation({
      clusterHead: 'trail shoes',
      competing: [
        page({ url: '/collections/a', impressionShare: 0.7 }),
        page({ url: '/blogs/b', pageType: 'blog_article', impressionShare: 0.3 }),
      ],
      inventory: [
        { url: '/pages/x', outboundInternalLinks: ['/blogs/b', '/pages/unrelated'] },
        { url: '/pages/y', outboundInternalLinks: ['/collections/a'] },
      ],
    })
    expect(result.linkRealignment).toEqual([
      { fromUrl: '/pages/x', currentTarget: '/blogs/b', suggestedTarget: '/collections/a' },
    ])
  })

  it('matches addresses that differ only by a trailing slash', () => {
    const result = buildConsolidationRecommendation({
      clusterHead: 'trail shoes',
      competing: [
        page({ url: '/collections/a', impressionShare: 0.7 }),
        page({ url: '/blogs/b/', pageType: 'blog_article', impressionShare: 0.3 }),
      ],
      inventory: [{ url: '/pages/x/', outboundInternalLinks: ['/blogs/b'] }],
    })
    expect(result.linkRealignment).toEqual([
      { fromUrl: '/pages/x', currentTarget: '/blogs/b', suggestedTarget: '/collections/a' },
    ])
  })
})

describe('rebuilding the recommendation from a stored opportunity row', () => {
  const fact = (key: string, value: string | number): EvidenceFact => ({
    key,
    value,
    source: 'gsc',
    fetchedAt: '2026-01-29T06:00:00.000Z',
  })

  it('reads the competing pages back out of the evidence the scan wrote', () => {
    const input = consolidationInputFromEvidence([
      fact('query_cluster', 'trail running shoes'),
      fact('competing_page_1', '/collections/trail-running'),
      fact('competing_page_1_impression_share', 0.42),
      fact('competing_page_1_position', 8.2),
      fact('competing_page_1_type', 'collection'),
      fact('competing_page_2', '/blogs/guides/trail'),
      fact('competing_page_2_impression_share', 0.33),
      fact('competing_page_2_position', 9.6),
      fact('competing_page_2_type', 'blog_article'),
    ])
    expect(input).not.toBeNull()
    const result = buildConsolidationRecommendation(input!)
    expect(result.primary.url).toBe('/collections/trail-running')
    expect(result.primary.pageType).toBe('collection')
    expect(result.secondary.map((p) => p.pageType)).toEqual(['blog_article'])
  })

  it('drops a page whose numbers are missing rather than guessing at them', () => {
    const input = consolidationInputFromEvidence([
      fact('query_cluster', 'q'),
      fact('competing_page_1', '/a'),
      fact('competing_page_1_impression_share', 0.5),
      fact('competing_page_1_position', 4),
      fact('competing_page_1_type', 'collection'),
      fact('competing_page_2', '/b'),
      fact('competing_page_2_type', 'collection'),
    ])
    expect(input?.competing.map((p) => p.url)).toEqual(['/a'])
  })

  it('says no rather than half a recommendation when the evidence is not a cannibalization', () => {
    expect(consolidationInputFromEvidence([fact('position', 7.3)])).toBeNull()
    expect(consolidationInputFromEvidence([fact('query_cluster', 'q')])).toBeNull()
  })
})

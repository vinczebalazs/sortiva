import { describe, expect, it } from 'vitest'
import { detectMetadataProblems, type MetadataPage } from './metadata'

const FETCHED_AT = '2026-03-01T00:00:00.000Z'

/** Distinct by default, so a test only has to state the thing it is about. */
function collection(overrides: Partial<MetadataPage> & { url: string }): MetadataPage {
  return {
    pageType: 'collection',
    seoTitle: `Listing title for ${overrides.url}`,
    seoDescription: `Listing description for ${overrides.url}`,
    ...overrides,
  }
}

describe('the store’s own search listings', () => {
  it('finds exactly two problems in the store the card describes', () => {
    // Two collections carrying the same listing title, and a third with none —
    // three pages, two pieces of work: making the pair differ, and writing the
    // one that is blank.
    const signals = detectMetadataProblems({
      fetchedAt: FETCHED_AT,
      pages: [
        collection({ url: '/collections/trail-running', seoTitle: 'Running shoes' }),
        collection({ url: '/collections/road-running', seoTitle: 'Running shoes' }),
        collection({ url: '/collections/hiking-boots', seoTitle: null }),
      ],
    })

    expect(signals).toHaveLength(2)
    expect(signals.map((signal) => signal.page)).toEqual([
      '/collections/hiking-boots',
      '/collections/road-running',
    ])

    const [missing, duplicate] = signals
    expect(missing).toMatchObject({ missingFields: ['seo_title'], duplicateFields: [] })
    expect(duplicate).toMatchObject({ missingFields: [], duplicateFields: ['seo_title'] })
    expect(duplicate!.sharedWith[0]!.pages).toEqual([
      '/collections/road-running',
      '/collections/trail-running',
    ])
  })

  it('finds a shared description as readily as a shared title', () => {
    const signals = detectMetadataProblems({
      fetchedAt: FETCHED_AT,
      pages: [
        collection({ url: '/collections/a', seoDescription: 'Shoes for running.' }),
        collection({ url: '/collections/b', seoDescription: 'Shoes for running.' }),
      ],
    })

    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ page: '/collections/a', duplicateFields: ['seo_description'] })
  })

  it('names one page for a shared listing, not every page sharing it', () => {
    const signals = detectMetadataProblems({
      fetchedAt: FETCHED_AT,
      pages: [
        collection({ url: '/collections/a', seoTitle: 'Shoes' }),
        collection({ url: '/collections/b', seoTitle: 'Shoes' }),
        collection({ url: '/collections/c', seoTitle: 'Shoes' }),
      ],
    })

    expect(signals).toHaveLength(1)
    expect(signals[0]!.sharedWith[0]!.pages).toHaveLength(3)
  })

  it('reports one piece of work per page however many fields are wrong', () => {
    const signals = detectMetadataProblems({
      fetchedAt: FETCHED_AT,
      pages: [collection({ url: '/collections/a', seoTitle: null, seoDescription: null })],
    })

    expect(signals).toHaveLength(1)
    expect(signals[0]!.missingFields).toEqual(['seo_title', 'seo_description'])
  })

  it('treats listings differing only in capitalisation as the same listing', () => {
    const signals = detectMetadataProblems({
      fetchedAt: FETCHED_AT,
      pages: [
        collection({ url: '/collections/a', seoTitle: 'Trail Running Shoes' }),
        collection({ url: '/collections/b', seoTitle: 'trail running shoes' }),
      ],
    })

    expect(signals).toHaveLength(1)
    expect(signals[0]!.duplicateFields).toEqual(['seo_title'])
  })

  it('leaves alone the pages that are not competing for a click', () => {
    const signals = detectMetadataProblems({
      fetchedAt: FETCHED_AT,
      pages: [
        { url: '/pages/returns', pageType: 'page', seoTitle: null, seoDescription: null },
        { url: '/blogs/news/hello', pageType: 'blog_article', seoTitle: null, seoDescription: null },
      ],
    })

    expect(signals).toEqual([])
  })

  it('says nothing about a store whose listings are all filled in and distinct', () => {
    const signals = detectMetadataProblems({
      fetchedAt: FETCHED_AT,
      pages: [collection({ url: '/collections/a' }), collection({ url: '/collections/b' })],
    })

    expect(signals).toEqual([])
  })

  it('stamps every fact with where it came from', () => {
    const [signal] = detectMetadataProblems({
      fetchedAt: FETCHED_AT,
      pages: [collection({ url: '/collections/a', seoTitle: null })],
    })

    expect(signal!.evidence.every((fact) => fact.source === 'content_inventory')).toBe(true)
    expect(signal!.evidence.every((fact) => fact.fetchedAt === FETCHED_AT)).toBe(true)
  })
})

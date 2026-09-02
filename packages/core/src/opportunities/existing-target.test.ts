import { describe, expect, it } from 'vitest'
import { rules } from '@sortiva/rules'
import type { QueryCluster } from '../contracts/opportunities'
import { existingTargetCheck, findExistingTarget } from './existing-target'
import { isCreateClearance } from './clearance'
import type { ClusterRankedPage, ExistingTargetInput, ExistingTargetPage } from './ports'

/**
 * The table this card exists for.
 *
 * Every combination of what Search Console says, what the store publishes and
 * whether the store has a Search Console connection at all, against the one
 * answer that matters: does the merchant get told to improve something they
 * already have, or do we write something new. Getting a row of this wrong
 * produces a second page of ours competing with the first, and nothing about
 * the product looks broken when it happens.
 */

const FAMILY = '11111111-1111-4111-8111-111111111111'
const OTHER_FAMILY = '22222222-2222-4222-8222-222222222222'

const config = rules().defaults.gates.existing_target_check

const cluster: QueryCluster = {
  head: 'best trail running shoes',
  members: ['trail running shoes best', 'top trail running shoes'],
  intentClass: 'buying_guide',
  familyIds: [FAMILY],
}

function page(overrides: Partial<ExistingTargetPage> = {}): ExistingTargetPage {
  return {
    url: 'https://shop.example/collections/trail-running',
    pageType: 'collection',
    intentClass: 'buying_guide',
    familyIds: [FAMILY],
    presence: 'unknown',
    ...overrides,
  }
}

function ranked(position: number | null, url = 'https://shop.example/collections/trail-running'): ClusterRankedPage {
  return { url, impressions: 4_200, position }
}

function input(overrides: Partial<ExistingTargetInput> = {}): ExistingTargetInput {
  return {
    cluster,
    rankedPages: [],
    pages: [],
    proxyRankings: [],
    limitedIntelligence: false,
    config,
    fetchedAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('existing-target check — what Search Console already showed', () => {
  const rows: {
    name: string
    position: number
    expect: 'strong' | 'weak'
  }[] = [
    { name: 'first page', position: 3.2, expect: 'strong' },
    { name: 'just off the first page', position: 12, expect: 'strong' },
    { name: 'at the edge of the band', position: config.match_position_max, expect: 'strong' },
    { name: 'past the band', position: config.match_position_max + 0.5, expect: 'weak' },
    { name: 'far past the band', position: 74, expect: 'weak' },
  ]

  for (const row of rows) {
    it(`a collection ranking ${row.name} is a ${row.expect} match`, () => {
      const { result, outcome } = existingTargetCheck(
        input({ rankedPages: [ranked(row.position)], pages: [page()] }),
      )

      expect(result.match?.strength).toBe(row.expect)
      expect(result.match?.via).toBe('gsc')
      expect(outcome.match).toBe(row.expect)
      if (row.expect === 'strong') {
        expect(outcome).toMatchObject({ action: 'OPTIMIZE', position: row.position })
        expect(result.clearance).toBeNull()
      } else {
        expect(outcome).toMatchObject({ action: 'CREATE_WITH_LINK' })
        expect(result.clearance?.linkTasks).toHaveLength(1)
      }
    })
  }

  it('takes the best-ranked of several pages', () => {
    const { outcome } = existingTargetCheck(
      input({
        rankedPages: [
          ranked(19, 'https://shop.example/collections/shoes'),
          ranked(6, 'https://shop.example/collections/trail-running'),
        ],
        pages: [page(), page({ url: 'https://shop.example/collections/shoes' })],
      }),
    )

    expect(outcome).toMatchObject({
      match: 'strong',
      url: 'https://shop.example/collections/trail-running',
    })
  })

  it('ignores a page that was never shown — no impressions is not a ranking', () => {
    const { outcome } = existingTargetCheck(
      input({ rankedPages: [{ ...ranked(4), impressions: 0 }] }),
    )
    expect(outcome).toEqual({ match: 'none' })
  })

  it('rewrites our own article rather than recommending changes to it', () => {
    const { outcome } = existingTargetCheck(
      input({
        rankedPages: [ranked(8, 'https://shop.example/blogs/guides/trail-shoes')],
        pages: [
          page({ url: 'https://shop.example/blogs/guides/trail-shoes', pageType: 'article_ours' }),
        ],
      }),
    )
    expect(outcome).toMatchObject({ match: 'strong', action: 'REFRESH' })
  })

  it('treats a product page as a supporting asset, never as the target', () => {
    const { result, outcome } = existingTargetCheck(
      input({
        rankedPages: [ranked(2, 'https://shop.example/products/trail-runner-1')],
        pages: [page({ url: 'https://shop.example/products/trail-runner-1', pageType: 'product' })],
      }),
    )

    expect(result.match?.weakness).toBe('product_page_for_category_intent')
    expect(outcome).toMatchObject({ match: 'weak', action: 'CREATE_WITH_LINK' })
  })
})

describe('existing-target check — what the store publishes', () => {
  it('matches a collection Google has not settled on yet', () => {
    const { result, outcome } = existingTargetCheck(input({ pages: [page()] }))

    expect(result.match?.via).toBe('content_mapping')
    expect(outcome).toMatchObject({ match: 'strong', action: 'OPTIMIZE' })
    expect(result.clearance).toBeNull()
  })

  it('does not match a collection of products we are not writing about', () => {
    const { outcome } = existingTargetCheck(
      input({ pages: [page({ familyIds: [OTHER_FAMILY] })] }),
    )
    expect(outcome).toEqual({ match: 'none' })
  })

  it('does not match a page built for a different purpose', () => {
    const { outcome } = existingTargetCheck(input({ pages: [page({ intentClass: 'how_to' })] }))
    expect(outcome).toEqual({ match: 'none' })
  })

  it('holds a page whose purpose nobody has established to a weak match, not a strong one', () => {
    const { result, outcome } = existingTargetCheck(input({ pages: [page({ intentClass: null })] }))

    expect(result.match?.weakness).toBe('page_intent_unknown')
    expect(outcome).toMatchObject({ match: 'weak', action: 'CREATE_WITH_LINK' })
  })

  it('lets a plainly relevant collection outrank a barely-ranking page Search Console found', () => {
    const { outcome } = existingTargetCheck(
      input({
        rankedPages: [ranked(88, 'https://shop.example/pages/about')],
        pages: [page({ url: 'https://shop.example/pages/about', familyIds: [] }), page()],
      }),
    )

    expect(outcome).toMatchObject({
      match: 'strong',
      via: 'content_mapping',
      url: 'https://shop.example/collections/trail-running',
    })
  })

  it('answers the same way whatever order the store lists its pages in', () => {
    const twin = page({ url: 'https://shop.example/collections/trail-shoes' })
    const forwards = existingTargetCheck(input({ pages: [page(), twin] })).outcome
    const backwards = existingTargetCheck(input({ pages: [twin, page()] })).outcome

    expect(forwards).toEqual(backwards)
  })
})

describe('existing-target check — a store with no Search Console connection', () => {
  const proxy = [
    { keyword: 'best trail running shoes', url: 'https://shop.example/collections/trail-running', position: 14 },
  ]

  it('falls back to what the vendor says this domain ranks for', () => {
    const { result, outcome } = existingTargetCheck(
      input({ limitedIntelligence: true, proxyRankings: proxy }),
    )

    expect(result.match?.via).toBe('limited_intelligence')
    expect(outcome).toMatchObject({ match: 'strong', action: 'OPTIMIZE', position: 14 })
  })

  it('matches on any spelling of the intent, not only the head', () => {
    const { outcome } = existingTargetCheck(
      input({
        limitedIntelligence: true,
        proxyRankings: [{ ...proxy[0]!, keyword: 'Top Trail Running Shoes' }],
      }),
    )
    expect(outcome).toMatchObject({ match: 'strong' })
  })

  it('treats a vendor position past the band as weak, exactly as Search Console would', () => {
    const { outcome } = existingTargetCheck(
      input({
        limitedIntelligence: true,
        proxyRankings: [{ ...proxy[0]!, position: config.match_position_max + 1 }],
      }),
    )
    expect(outcome).toMatchObject({ match: 'weak', action: 'CREATE_WITH_LINK' })
  })

  it('never spends the fallback on a store that has Search Console', () => {
    const { outcome } = existingTargetCheck(
      input({ limitedIntelligence: false, proxyRankings: proxy }),
    )
    expect(outcome).toEqual({ match: 'none' })
  })

  it('finds nothing when neither the vendor nor the inventory knows of a page', () => {
    const { result, outcome } = existingTargetCheck(input({ limitedIntelligence: true }))

    expect(outcome).toEqual({ match: 'none' })
    expect(isCreateClearance(result.clearance)).toBe(true)
    expect(result.clearance?.linkTasks).toEqual([])
  })
})

describe('existing-target check — pages the merchant has taken down', () => {
  it('never proposes improving a page recorded as gone', () => {
    const { outcome } = existingTargetCheck(
      input({
        rankedPages: [ranked(5)],
        pages: [page({ presence: 'removed' })],
      }),
    )
    expect(outcome).toEqual({ match: 'none' })
  })

  it('treats a page whose fate nothing records as still there, and says so in the evidence', () => {
    const { result, outcome } = existingTargetCheck(
      input({ rankedPages: [ranked(5)], pages: [page({ presence: 'unknown' })] }),
    )

    expect(outcome).toMatchObject({ match: 'strong' })
    expect(result.evidence).toContainEqual(
      expect.objectContaining({ key: 'existing_target_presence', value: 'unknown' }),
    )
  })
})

describe('existing-target check — evidence', () => {
  it('stamps every fact with where it came from and when it was read', () => {
    const result = findExistingTarget(input({ rankedPages: [ranked(9)], pages: [page()] }))

    expect(result.evidence.every((fact) => fact.source && fact.fetchedAt)).toBe(true)
    expect(result.evidence).toContainEqual(
      expect.objectContaining({ key: 'existing_target_url', source: 'gsc', window: `${config.window_days}d` }),
    )
    expect(result.evidence).toContainEqual(
      expect.objectContaining({ key: 'existing_target_match', value: 'strong' }),
    )
  })

  it('names the vendor as the source when the answer came from the fallback', () => {
    const result = findExistingTarget(
      input({
        limitedIntelligence: true,
        proxyRankings: [
          { keyword: 'best trail running shoes', url: 'https://shop.example/collections/trail-running', position: 9 },
        ],
      }),
    )

    expect(result.evidence).toContainEqual(
      expect.objectContaining({ key: 'existing_target_url', source: 'dataforseo' }),
    )
    expect(result.limitedIntelligence).toBe(true)
  })
})

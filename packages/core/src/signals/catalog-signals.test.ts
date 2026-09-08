import { describe, expect, it } from 'vitest'
import { scenario } from '../fixtures'
import { existingTargetCheck } from '../opportunities/existing-target'
import type { ExistingTargetPage } from '../opportunities/ports'
import type { QueryCluster } from '../contracts/opportunities'
import { detectCatalogRichnessGaps, keywordsClearingSubstanceFloor } from './richness-gap'
import { detectCompetitorCoverageGaps } from './competitor-gap'
import { detectFamilyCoverageGaps } from './family-coverage'
import { detectUncoveredCommercialQueries, UncheckedCandidateError } from './uncovered-query'
import { substanceInventory } from './substance'
import type { ExistingCoverage, KeywordCandidate } from './candidates'
import { FETCHED_AT, rulesLayer, substanceInputFor } from './testing'

/**
 * The four catalogue- and market-driven things the product notices without
 * Search Console, and the two worked examples the spec runs through for them.
 */

const layer = rulesLayer()
const ROAD_RUNNING = 'road_running'
const TRAIL_RUNNING = 'trail-running'

function candidate(overrides: Partial<KeywordCandidate> = {}): KeywordCandidate {
  return {
    keyword: 'best road running shoes',
    monthlySearchVolume: layer.gates.demand_floor.monthly_search_volume_min * 4,
    intentClass: 'buying_guide',
    familyIds: [ROAD_RUNNING],
    source: 'merchant_seed',
    ...overrides,
  }
}

function coverageOf(strength: ExistingCoverage['strength'], keyword: string, url?: string) {
  return new Map<string, ExistingCoverage>([[keyword, { strength, ...(url ? { url } : {}) }]])
}

describe('worked example 3 — people are searching, and the store has nothing for them', () => {
  /**
   * The fixture's store sells road-running shoes and hiking boots and, by its
   * own declaration, has no suitable URL for this search. The store's page list
   * is where that shows: the hiking-boots collection exists and the
   * road-running one does not, which is an ordinary state for a shop whose
   * products are not all in collections. The scenario is asserted as it
   * declares itself rather than by editing the shared fixture, which three
   * lanes read.
   */
  const example = scenario(3)
  const products = substanceInputFor(example.store, ROAD_RUNNING)
  const substance = substanceInventory(products, layer.gates.substance_floor)

  const cluster: QueryCluster = {
    head: 'best road running shoes',
    members: ['road running shoes for beginners'],
    intentClass: 'buying_guide',
    familyIds: [ROAD_RUNNING],
  }

  const inventory: ExistingTargetPage[] = [
    {
      url: '/collections/hiking-boots',
      pageType: 'collection',
      intentClass: null,
      familyIds: ['hiking_boots'],
      presence: 'unknown',
    },
  ]

  it('the store has enough to say about the range', () => {
    expect(substance.passes).toBe(true)
    expect(substance.contributingProducts).toBeGreaterThanOrEqual(
      layer.gates.substance_floor.contributing_products_min,
    )
  })

  it('the existing-target check finds nothing, exactly as the fixture declares', () => {
    expect(example.hasSuitableUrl).toBe(false)

    const { outcome } = existingTargetCheck({
      cluster,
      rankedPages: [],
      pages: inventory,
      proxyRankings: [],
      limitedIntelligence: false,
      config: layer.gates.existing_target_check,
      fetchedAt: FETCHED_AT,
    })

    expect(outcome).toEqual({ match: 'none' })
  })

  it('produces one uncovered-search signal, with the evidence the example states', () => {
    const signals = detectUncoveredCommercialQueries({
      candidates: [candidate()],
      coverage: coverageOf('none', 'best road running shoes'),
      familiesWithSubstance: new Set([ROAD_RUNNING]),
      config: layer.signals.uncovered_commercial_query,
      gates: layer.gates,
      fetchedAt: FETCHED_AT,
    })

    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({
      signalType: 'uncovered_commercial_query',
      keyword: 'best road running shoes',
      familyIds: [ROAD_RUNNING],
      weakExistingTarget: null,
    })
  })
})

describe('worked example 7 — a good search the catalogue cannot answer honestly', () => {
  const example = scenario(7)
  const products = substanceInputFor(example.store, TRAIL_RUNNING)
  const substance = substanceInventory(products, layer.gates.substance_floor)

  it('the fixture store really does fail the floor, or the example proves nothing', () => {
    expect(products.length).toBeGreaterThan(0)
    expect(substance.passes).toBe(false)
  })

  it('holds the candidate back and names the products and the missing details', () => {
    const signals = detectCatalogRichnessGaps({
      candidates: [
        {
          ...candidate({ keyword: 'best trail running shoes', familyIds: [TRAIL_RUNNING] }),
          winnability: layer.gates.winnability.limited_intelligence_constant,
          substance,
        },
      ],
      gates: layer.gates,
      fetchedAt: FETCHED_AT,
    })

    expect(signals).toHaveLength(1)
    expect(signals[0]!.signalType).toBe('catalog_richness_gap')
    expect(signals[0]!.shortfalls.length).toBeGreaterThan(0)
    expect(signals[0]!.shortfalls[0]!.missingFields).toContain('dimensions')
    expect(signals[0]!.shortfalls[0]!.productId).toMatch(/^trail-running-/)
  })

  it('says nothing about a search nobody makes, however thin the catalogue', () => {
    const signals = detectCatalogRichnessGaps({
      candidates: [
        {
          ...candidate({ monthlySearchVolume: 0 }),
          winnability: 0.9,
          substance,
        },
      ],
      gates: layer.gates,
      fetchedAt: FETCHED_AT,
    })

    expect(signals).toEqual([])
  })

  it('says nothing about a search this store could never rank for', () => {
    const signals = detectCatalogRichnessGaps({
      candidates: [{ ...candidate(), winnability: 0, substance }],
      gates: layer.gates,
      fetchedAt: FETCHED_AT,
    })

    expect(signals).toEqual([])
  })

  describe('and afterwards, telling a finished checklist from a search that went quiet', () => {
    const held = { ...candidate({ keyword: 'best trail running shoes' }), winnability: 0.9, substance }
    const filledIn = {
      ...held,
      substance: { ...substance, passes: true, shortfalls: [] },
    }

    it('names the search whose products now say enough', () => {
      const cleared = keywordsClearingSubstanceFloor({
        candidates: [filledIn],
        gates: layer.gates,
        fetchedAt: FETCHED_AT,
      })

      expect([...cleared]).toEqual(['best trail running shoes'])
    })

    it('bites: the same search with the same thin products is not named', () => {
      const cleared = keywordsClearingSubstanceFloor({
        candidates: [held],
        gates: layer.gates,
        fetchedAt: FETCHED_AT,
      })

      expect([...cleared]).toEqual([])
    })

    it('still names it when the search lost its volume, because the merchant still did the work', () => {
      const cleared = keywordsClearingSubstanceFloor({
        candidates: [{ ...filledIn, monthlySearchVolume: 0 }],
        gates: layer.gates,
        fetchedAt: FETCHED_AT,
      })

      expect([...cleared]).toEqual(['best trail running shoes'])
    })
  })
})

describe('uncovered searches — what disqualifies one', () => {
  const base = {
    familiesWithSubstance: new Set([ROAD_RUNNING]),
    config: layer.signals.uncovered_commercial_query,
    gates: layer.gates,
    fetchedAt: FETCHED_AT,
  }

  it('a page of ours already serving the search takes the work instead', () => {
    const signals = detectUncoveredCommercialQueries({
      ...base,
      candidates: [candidate()],
      coverage: coverageOf('strong', 'best road running shoes', '/collections/road-running'),
    })
    expect(signals).toEqual([])
  })

  it('a page too weak to take the work over does not block it, and travels as the link target', () => {
    const signals = detectUncoveredCommercialQueries({
      ...base,
      candidates: [candidate()],
      coverage: coverageOf('weak', 'best road running shoes', '/products/road-runner-1'),
    })

    expect(signals).toHaveLength(1)
    expect(signals[0]!.weakExistingTarget).toBe('/products/road-runner-1')
  })

  it('refuses to answer for a search nobody ran the check on', () => {
    expect(() =>
      detectUncoveredCommercialQueries({
        ...base,
        candidates: [candidate()],
        coverage: new Map(),
      }),
    ).toThrow(UncheckedCandidateError)
  })

  it('ignores a search too few people make', () => {
    const signals = detectUncoveredCommercialQueries({
      ...base,
      candidates: [candidate({ monthlySearchVolume: 1 })],
      coverage: coverageOf('none', 'best road running shoes'),
    })
    expect(signals).toEqual([])
  })

  it('honours a topic the merchant pinned even with no volume behind it', () => {
    const signals = detectUncoveredCommercialQueries({
      ...base,
      candidates: [candidate({ monthlySearchVolume: null, pinned: true })],
      coverage: coverageOf('none', 'best road running shoes'),
    })
    expect(signals).toHaveLength(1)
  })

  it('ignores a search that is not a shopper deciding what to buy', () => {
    const signals = detectUncoveredCommercialQueries({
      ...base,
      candidates: [candidate({ intentClass: 'informational' })],
      coverage: coverageOf('none', 'best road running shoes'),
    })
    expect(signals).toEqual([])
  })

  it('ignores a search whose products we know nothing about', () => {
    const signals = detectUncoveredCommercialQueries({
      ...base,
      familiesWithSubstance: new Set<string>(),
      candidates: [candidate()],
      coverage: coverageOf('none', 'best road running shoes'),
    })
    expect(signals).toEqual([])
  })
})

describe('competitors found for something we sell', () => {
  const config = layer.signals.competitor_coverage_gap

  function gapCandidate(overrides: Record<string, unknown> = {}) {
    return {
      ...candidate({ keyword: 'trail running shoes' }),
      familyIds: [TRAIL_RUNNING],
      competitorRankings: [
        { domain: 'rival-one.com', position: 3, url: 'https://rival-one.com/a' },
        { domain: 'rival-two.com', position: 7, url: 'https://rival-two.com/b' },
      ],
      ourPosition: null,
      ourUrl: null,
      ...overrides,
    }
  }

  it('fires when two competitors rank and we hold nothing', () => {
    const signals = detectCompetitorCoverageGaps({
      candidates: [gapCandidate()],
      config,
      fetchedAt: FETCHED_AT,
    })

    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({ ourPosition: null, ourRankingUrl: null })
    expect(signals[0]!.competitorsRanking).toHaveLength(2)
  })

  it('does not fire on one competitor doing something unusual', () => {
    const signals = detectCompetitorCoverageGaps({
      candidates: [
        gapCandidate({
          competitorRankings: [{ domain: 'rival-one.com', position: 3, url: 'https://rival-one.com/a' }],
        }),
      ],
      config,
      fetchedAt: FETCHED_AT,
    })
    expect(signals).toEqual([])
  })

  it('counts a competitor once however many of their pages rank', () => {
    const signals = detectCompetitorCoverageGaps({
      candidates: [
        gapCandidate({
          competitorRankings: [
            { domain: 'rival-one.com', position: 3, url: 'https://rival-one.com/a' },
            { domain: 'rival-one.com', position: 5, url: 'https://rival-one.com/b' },
          ],
        }),
      ],
      config,
      fetchedAt: FETCHED_AT,
    })
    expect(signals).toEqual([])
  })

  it('says nothing when the store already ranks well for it', () => {
    const signals = detectCompetitorCoverageGaps({
      candidates: [gapCandidate({ ourPosition: 4, ourUrl: '/collections/trail-running' })],
      config,
      fetchedAt: FETCHED_AT,
    })
    expect(signals).toEqual([])
  })

  it('names our own middling page, so improving it stays the cheaper option', () => {
    const signals = detectCompetitorCoverageGaps({
      candidates: [
        gapCandidate({
          ourPosition: config.optimize_position_max - 1,
          ourUrl: '/collections/trail-running/',
        }),
      ],
      config,
      fetchedAt: FETCHED_AT,
    })

    expect(signals).toHaveLength(1)
    expect(signals[0]!.ourRankingUrl).toBe('/collections/trail-running')
  })

  it('ignores a search that maps to nothing the store sells', () => {
    const signals = detectCompetitorCoverageGaps({
      candidates: [gapCandidate({ familyIds: [] })],
      config,
      fetchedAt: FETCHED_AT,
    })
    expect(signals).toEqual([])
  })
})

describe('a range the store earns from with nothing written about it', () => {
  const config = layer.signals.product_family_coverage_gap

  function familyCandidate(overrides: Record<string, unknown> = {}) {
    return {
      familyId: TRAIL_RUNNING,
      familyName: 'Trail Running',
      isTopSeller: true,
      revenueShare: config.revenue_share_min * 2,
      mappedContent: [],
      keywordCandidatesClearingFloor: config.keyword_candidates_min,
      intentClass: 'buying_guide' as const,
      ...overrides,
    }
  }

  it('fires for a best-selling range with nothing pointing at it', () => {
    const signals = detectFamilyCoverageGaps({
      candidates: [familyCandidate()],
      config,
      fetchedAt: FETCHED_AT,
    })
    expect(signals).toHaveLength(1)
  })

  it('fires on revenue share alone, without the best-seller badge', () => {
    const signals = detectFamilyCoverageGaps({
      candidates: [familyCandidate({ isTopSeller: false })],
      config,
      fetchedAt: FETCHED_AT,
    })
    expect(signals).toHaveLength(1)
  })

  it('leaves alone a range the store barely earns from', () => {
    const signals = detectFamilyCoverageGaps({
      candidates: [familyCandidate({ isTopSeller: false, revenueShare: 0 })],
      config,
      fetchedAt: FETCHED_AT,
    })
    expect(signals).toEqual([])
  })

  it('treats a collection nobody has ever been shown as no coverage at all', () => {
    const signals = detectFamilyCoverageGaps({
      candidates: [
        familyCandidate({
          mappedContent: [{ url: '/collections/trail-running', kind: 'store', ranks: false }],
        }),
      ],
      config,
      fetchedAt: FETCHED_AT,
    })

    expect(signals).toHaveLength(1)
    expect(signals[0]!.unrankedPages).toEqual(['/collections/trail-running'])
  })

  it('says nothing once a page of the store’s is actually being shown', () => {
    const signals = detectFamilyCoverageGaps({
      candidates: [
        familyCandidate({
          mappedContent: [{ url: '/collections/trail-running', kind: 'store', ranks: true }],
        }),
      ],
      config,
      fetchedAt: FETCHED_AT,
    })
    expect(signals).toEqual([])
  })

  it('says nothing once we have written about the range ourselves', () => {
    const signals = detectFamilyCoverageGaps({
      candidates: [
        familyCandidate({
          mappedContent: [{ url: '/blogs/guides/trail-shoes', kind: 'ours', ranks: false }],
        }),
      ],
      config,
      fetchedAt: FETCHED_AT,
    })
    expect(signals).toEqual([])
  })

  it('says nothing when no search maps to the range', () => {
    const signals = detectFamilyCoverageGaps({
      candidates: [familyCandidate({ keywordCandidatesClearingFloor: 0 })],
      config,
      fetchedAt: FETCHED_AT,
    })
    expect(signals).toEqual([])
  })
})

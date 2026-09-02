import { describe, expect, it } from 'vitest'
import { emptyFactSheet } from '../distill/schema'
import { substanceInventory, type ProductSubstance } from './substance'
import { signalRuns, signalsNeedingSearchConsole, signalsWithoutSearchConsole } from './limited-intelligence'
import { rulesLayer } from './testing'

const layer = rulesLayer()
const floor = layer.gates.substance_floor

function product(id: string, sheet: Partial<ReturnType<typeof emptyFactSheet>>): ProductSubstance {
  return {
    productId: id,
    title: `Product ${id}`,
    familyId: 'family-1',
    factSheet: { ...emptyFactSheet(), ...sheet },
  }
}

/** Five populated fields, comfortably over the per-product floor, all distinct per product. */
function wellDescribed(id: string, seed: string): ProductSubstance {
  return product(id, {
    material: `material-${seed}`,
    weight: `weight-${seed}`,
    dimensions: `dimensions-${seed}`,
    care: `care-${seed}`,
    use_cases_stated: [`use-${seed}`],
  })
}

describe('do we know enough to write about this range', () => {
  it('counts only products described well enough to be a source', () => {
    const inventory = substanceInventory(
      [
        wellDescribed('a', '1'),
        wellDescribed('b', '2'),
        wellDescribed('c', '3'),
        product('d', { material: 'leather' }),
      ],
      floor,
    )

    expect(inventory.contributingProducts).toBe(3)
    expect(inventory.productsConsidered).toBe(4)
    expect(inventory.passes).toBe(true)
  })

  it('counts a fact once however many products state it', () => {
    const clones = ['a', 'b', 'c', 'd', 'e'].map((id) => wellDescribed(id, 'same'))
    const inventory = substanceInventory(clones, floor)

    // Five identical listings know five things between them, not twenty-five.
    expect(inventory.contributingProducts).toBe(5)
    expect(inventory.distinctFacts).toBe(5)
    expect(inventory.passes).toBe(false)
  })

  it('fails a range with plenty to say spread over too few products', () => {
    const inventory = substanceInventory(
      [
        product('a', {
          material: 'leather',
          weight: '300 g',
          dimensions: '8 mm',
          care: 'wipe clean',
          capacity: '12 l',
          origin: 'Portugal',
          certifications: ['bluesign'],
          compatibility: ['gaiters'],
          use_cases_stated: ['trail', 'road'],
          verifiable_claims: ['waterproof to 10m'],
        }),
      ],
      floor,
    )

    expect(inventory.distinctFacts).toBeGreaterThanOrEqual(floor.distinct_facts_min)
    expect(inventory.contributingProducts).toBeLessThan(floor.contributing_products_min)
    expect(inventory.passes).toBe(false)
  })

  it('names the products holding a range back, worst first, and what each is missing', () => {
    const inventory = substanceInventory([wellDescribed('a', '1'), product('b', {})], floor)

    expect(inventory.shortfalls).toHaveLength(1)
    expect(inventory.shortfalls[0]).toMatchObject({ productId: 'b', populatedFields: 0 })
    expect(inventory.shortfalls[0]!.missingFields).toContain('material')
  })

  it('separates "just enough" from "plenty to say"', () => {
    const many = Array.from({ length: 12 }, (_, index) => wellDescribed(`p${index}`, `${index}`))
    const inventory = substanceInventory(many, floor)

    expect(inventory.passes).toBe(true)
    expect(inventory.clearsWithMargin).toBe(true)
  })
})

describe('a store with no Search Console connection', () => {
  it('names the signals that go quiet, and they are the ones that read Google’s record', () => {
    const quiet = signalsNeedingSearchConsole(layer.signals)

    expect(quiet).toContain('striking_distance')
    expect(quiet).toContain('low_ctr_at_strong_rank')
    expect(quiet).toContain('content_decay')
    expect(quiet).toContain('cannibalization')
    expect(quiet).not.toContain('uncovered_commercial_query')
  })

  it('keeps the catalogue- and market-driven signals running', () => {
    const running = signalsWithoutSearchConsole(layer.signals)

    for (const type of [
      'uncovered_commercial_query',
      'competitor_coverage_gap',
      'product_family_coverage_gap',
      'catalog_richness_gap',
      'missing_or_weak_metadata',
    ] as const) {
      expect(running).toContain(type)
    }
  })

  it('runs a search-data signal for a connected store and not for a limited one', () => {
    expect(signalRuns(layer.signals, 'striking_distance', false)).toBe(true)
    expect(signalRuns(layer.signals, 'striking_distance', true)).toBe(false)
    expect(signalRuns(layer.signals, 'uncovered_commercial_query', true)).toBe(true)
  })

  it('never runs a signal the product has not built yet', () => {
    expect(signalRuns(layer.signals, 'freshness_opportunity', false)).toBe(false)
    expect(signalRuns(layer.signals, 'orphan_page', false)).toBe(false)
  })
})

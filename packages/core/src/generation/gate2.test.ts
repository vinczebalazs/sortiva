import { describe, expect, it } from 'vitest'
import { emptyFactSheet } from '../distill/schema'
import { assembleEvidencePack, type EvidencePackProduct } from './evidence-pack'
import { runGate2 } from './gate2'

const CONFIG = { distinct_claims_min: 6, boilerplate_repeat_share_min: 0.8, boilerplate_ratio_max: 0.9 }

function product(id: string, family: string, overrides: Partial<EvidencePackProduct['factSheet']> = {}): EvidencePackProduct {
  return {
    productId: id,
    familyId: family,
    title: `Product ${id}`,
    images: [],
    factSheet: { ...emptyFactSheet(), ...overrides },
  }
}

describe('runGate2', () => {
  it('holds a pack where the same generic fact is repeated across almost every product (90% boilerplate)', () => {
    // Ten products in one family, nine of them stating the identical material
    // and nothing else distinct — exactly the "90%-boilerplate" case main
    // §8.3 names.
    const products = Array.from({ length: 10 }, (_, i) =>
      product(`p${i}`, 'f1', { material: i < 9 ? 'plastic' : 'aluminium' }),
    )
    const pack = assembleEvidencePack({
      accountId: 'a1',
      topicId: 't1',
      intentClass: 'buying_guide',
      targetKeyword: 'water bottles',
      families: [{ familyId: 'f1', name: 'Bottles', differentiationAxes: ['material'] }],
      products,
      serp: { keyword: 'water bottles', locale: 'en-US', topResultCount: 0, averageWordCount: null, competitorAngles: [] },
      linkTasks: [],
      now: new Date(),
    })

    const result = runGate2(pack, CONFIG)
    expect(result.outcome).toBe('held_thin_pack')
    expect(result.reasonTemplateKey).toBe('gate2.held_thin_pack')
    expect(result.boilerplateEntries).toHaveLength(1)
    expect(result.boilerplateEntries[0]!.repeatShare).toBeCloseTo(0.9)
  })

  it('admits a pack with enough distinct, specific claims', () => {
    const products = [
      product('p1', 'f1', { material: 'leather', capacity: '20 litres', weight: '1.2 kg', origin: 'Portugal' }),
      product('p2', 'f1', { material: 'canvas', capacity: '30 litres', weight: '0.9 kg', origin: 'Vietnam' }),
      product('p3', 'f1', { material: 'nylon', capacity: '15 litres', weight: '0.7 kg', origin: 'Vietnam' }),
    ]
    const pack = assembleEvidencePack({
      accountId: 'a1',
      topicId: 't1',
      intentClass: 'buying_guide',
      targetKeyword: 'backpacks',
      families: [{ familyId: 'f1', name: 'Backpacks', differentiationAxes: ['material', 'capacity'] }],
      products,
      serp: { keyword: 'backpacks', locale: 'en-US', topResultCount: 0, averageWordCount: null, competitorAngles: [] },
      linkTasks: [],
      now: new Date(),
    })

    const result = runGate2(pack, CONFIG)
    expect(result.outcome).toBe('admitted')
    expect(result.reasonTemplateKey).toBeNull()
    expect(result.distinctClaimCount).toBeGreaterThanOrEqual(CONFIG.distinct_claims_min)
  })

  it('holds a pack with too few distinct claims even when nothing repeats', () => {
    const products = [product('p1', 'f1', { material: 'leather' }), product('p2', 'f1', { material: 'canvas' })]
    const pack = assembleEvidencePack({
      accountId: 'a1',
      topicId: 't1',
      intentClass: 'buying_guide',
      targetKeyword: 'bags',
      families: [{ familyId: 'f1', name: 'Bags', differentiationAxes: ['material'] }],
      products,
      serp: { keyword: 'bags', locale: 'en-US', topResultCount: 0, averageWordCount: null, competitorAngles: [] },
      linkTasks: [],
      now: new Date(),
    })

    const result = runGate2(pack, CONFIG)
    expect(result.outcome).toBe('held_thin_pack')
    expect(result.distinctClaimCount).toBeLessThan(CONFIG.distinct_claims_min)
  })
})

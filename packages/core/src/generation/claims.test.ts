import { describe, expect, it } from 'vitest'
import { emptyFactSheet } from '../distill/schema'
import { assembleEvidencePack, type EvidencePackProduct } from './evidence-pack'
import { deterministicDerivedClaims, deterministicMerchantClaims } from './claims'

function product(overrides: Partial<EvidencePackProduct> & { productId: string; familyId: string }): EvidencePackProduct {
  return {
    title: 'Product',
    images: [],
    factSheet: emptyFactSheet(),
    ...overrides,
  }
}

describe('deterministicMerchantClaims', () => {
  it('emits one claim per populated scalar and per list entry', () => {
    const pack = assembleEvidencePack({
      accountId: 'a1',
      topicId: 't1',
      intentClass: 'buying_guide',
      targetKeyword: 'trail shoes',
      families: [],
      products: [
        product({
          productId: 'p1',
          familyId: 'f1',
          title: 'Trailblazer',
          factSheet: {
            ...emptyFactSheet(),
            material: 'leather',
            use_cases_stated: ['hiking', 'trail running'],
          },
        }),
      ],
      serp: { keyword: 'trail shoes', locale: 'en-US', topResultCount: 0, averageWordCount: null, competitorAngles: [] },
      linkTasks: [],
      now: new Date('2026-09-03T00:00:00Z'),
    })

    const claims = deterministicMerchantClaims(pack)
    expect(claims).toHaveLength(3) // material + 2 use cases
    expect(claims.every((c) => c.kind === 'merchant_fact')).toBe(true)
    expect(claims.every((c) => c.confidence === 'high')).toBe(true)
    expect(claims.some((c) => c.text.includes('leather'))).toBe(true)
    expect(claims.some((c) => c.text.includes('hiking'))).toBe(true)
  })

  it('produces no claim for an unpopulated fact sheet', () => {
    const pack = assembleEvidencePack({
      accountId: 'a1',
      topicId: 't1',
      intentClass: 'buying_guide',
      targetKeyword: 'k',
      families: [],
      products: [product({ productId: 'p1', familyId: 'f1' })],
      serp: { keyword: 'k', locale: 'en-US', topResultCount: 0, averageWordCount: null, competitorAngles: [] },
      linkTasks: [],
      now: new Date(),
    })
    expect(deterministicMerchantClaims(pack)).toHaveLength(0)
  })
})

describe('deterministicDerivedClaims', () => {
  it('re-derives one arithmetic comparison per numeric field from the merchant claims, in code', () => {
    const pack = assembleEvidencePack({
      accountId: 'a1',
      topicId: 't1',
      intentClass: 'comparison',
      targetKeyword: 'water bottles',
      families: [{ familyId: 'f1', name: 'Bottles', differentiationAxes: ['capacity'] }],
      products: [
        product({ productId: 'p1', familyId: 'f1', title: 'Small', factSheet: { ...emptyFactSheet(), capacity: '500 ml' } }),
        product({ productId: 'p2', familyId: 'f1', title: 'Large', factSheet: { ...emptyFactSheet(), capacity: '1000 ml' } }),
      ],
      serp: { keyword: 'water bottles', locale: 'en-US', topResultCount: 0, averageWordCount: null, competitorAngles: [] },
      linkTasks: [],
      now: new Date(),
    })

    const merchantClaims = deterministicMerchantClaims(pack)
    const derived = deterministicDerivedClaims(pack, merchantClaims, merchantClaims.length)

    expect(derived).toHaveLength(1)
    expect(derived[0]!.kind).toBe('derived_fact')
    expect(derived[0]!.text).toContain('Large has more capacity than Small')
    expect(derived[0]!.text).toContain('1000ml')
    expect(derived[0]!.text).toContain('500ml')
    // Names the merchant-fact claims it rests on, not the raw numbers restated.
    expect(derived[0]!.evidence).toHaveLength(2)
    expect(derived[0]!.evidence.every((e) => e.kind === 'claim')).toBe(true)
  })

  it('does not compare values with different units', () => {
    const pack = assembleEvidencePack({
      accountId: 'a1',
      topicId: 't1',
      intentClass: 'comparison',
      targetKeyword: 'k',
      families: [{ familyId: 'f1', name: 'F', differentiationAxes: [] }],
      products: [
        product({ productId: 'p1', familyId: 'f1', factSheet: { ...emptyFactSheet(), capacity: '500 ml' } }),
        product({ productId: 'p2', familyId: 'f1', factSheet: { ...emptyFactSheet(), capacity: '2 litres' } }),
      ],
      serp: { keyword: 'k', locale: 'en-US', topResultCount: 0, averageWordCount: null, competitorAngles: [] },
      linkTasks: [],
      now: new Date(),
    })
    const merchantClaims = deterministicMerchantClaims(pack)
    expect(deterministicDerivedClaims(pack, merchantClaims, merchantClaims.length)).toHaveLength(0)
  })
})

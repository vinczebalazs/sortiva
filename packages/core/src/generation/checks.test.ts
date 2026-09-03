import { describe, expect, it } from 'vitest'
import type { ClaimPlan } from './claims'
import type { CitableProduct, Draft } from './draft'
import { answerIsFirst, checkGrounding, checkShape, faqIsConditional } from './checks'

const PLAN: ClaimPlan = {
  claims: [
    { id: 'c1', text: 'The tank holds 20 litres.', kind: 'merchant_fact', confidence: 'high', evidence: [] },
    { id: 'c2', text: 'The tank is made of steel.', kind: 'merchant_fact', confidence: 'high', evidence: [] },
  ],
  gaps: [],
}

const PRODUCTS: CitableProduct[] = [{ id: 'p1', productId: 'prod-1', title: 'Big Tank' }]

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    title: 'Title',
    metaDescription: 'Description',
    intro: 'The 20-litre tank is the right choice for most sheds.',
    sections: [{ heading: 'Details', body: 'It holds 20 litres[[c1]] and is made of steel[[c2]].' }],
    faq: [],
    productMentions: [],
    ...overrides,
  }
}

describe('checkGrounding', () => {
  it('passes a draft whose every citation and product mention resolves', () => {
    const d = draft({
      sections: [{ heading: 'Details', body: 'The {{p1}} holds 20 litres[[c1]].' }],
      productMentions: [{ id: 'p1', productId: 'prod-1', refType: 'recommendation', fields: ['price'] }],
    })
    const result = checkGrounding(d, PLAN, PRODUCTS)
    expect(result.grounded).toBe(true)
    expect(result.issues).toHaveLength(0)
    expect(result.citedClaimIds).toEqual(['c1'])
  })

  it('fails a draft that cites a claim id no plan approved — the fabrication route this design closes off', () => {
    const d = draft({ sections: [{ heading: 'Details', body: 'It holds 40 litres[[c99]].' }] })
    const result = checkGrounding(d, PLAN, PRODUCTS)
    expect(result.grounded).toBe(false)
    expect(result.issues[0]!.kind).toBe('unknown_claim_marker')
  })

  it('fails a draft that mentions a product token with no declared productMentions entry', () => {
    const d = draft({ sections: [{ heading: 'Details', body: 'Try the {{p9}}.' }] })
    const result = checkGrounding(d, PLAN, PRODUCTS)
    expect(result.grounded).toBe(false)
    expect(result.issues.some((i) => i.kind === 'undeclared_product_mention')).toBe(true)
  })

  it('fails a draft whose declared product mention names a product the writer was never given', () => {
    const d = draft({ productMentions: [{ id: 'p9', productId: 'ghost', refType: 'link', fields: ['url'] }] })
    const result = checkGrounding(d, PLAN, PRODUCTS)
    expect(result.grounded).toBe(false)
    expect(result.issues.some((i) => i.kind === 'unknown_product_mention')).toBe(true)
  })
})

describe('answerIsFirst', () => {
  it('fails when the intro paragraph is empty — every shape\'s universal rule', () => {
    expect(answerIsFirst(draft({ intro: '' }))).toBe(false)
    expect(answerIsFirst(draft({ intro: '   ' }))).toBe(false)
    expect(answerIsFirst(draft())).toBe(true)
  })
})

describe('checkShape', () => {
  it('fails a comparison that refuses to recommend', () => {
    const d = draft({ sections: [{ heading: 'Verdict', body: 'It depends on your needs.' }] })
    const result = checkShape('comparison', d)
    expect(result.passed).toBe(false)
    expect(result.reason).toContain('refuses to recommend')
  })

  it('passes a comparison with a real verdict', () => {
    const d = draft({ sections: [{ heading: 'Verdict', body: 'Choose the Trailblazer for wet terrain[[c1]].' }] })
    expect(checkShape('comparison', d).passed).toBe(true)
  })

  it('fails a buying guide with no selection-criteria content', () => {
    const d = draft({ sections: [{ heading: 'Selection criteria: by terrain', body: '' }] })
    const result = checkShape('buying_guide', d)
    expect(result.passed).toBe(false)
    expect(result.reason).toContain('arbitrary')
  })

  it('fails when the universal answer-first rule fails, under any shape', () => {
    const d = draft({ intro: '' })
    expect(checkShape('sizing', d).passed).toBe(false)
    expect(checkShape('sizing', d).reason).toContain('answer is not in the first paragraph')
  })
})

describe('faqIsConditional', () => {
  it('fails an FAQ block written when research turned up no questions', () => {
    const d = draft({ faq: [{ question: 'Is it waterproof?', answer: 'Yes, to 10m.' }] })
    expect(faqIsConditional(d, false).passed).toBe(false)
  })

  it('passes no FAQ at all, and a real FAQ backed by research', () => {
    expect(faqIsConditional(draft({ faq: [] }), false).passed).toBe(true)
    const d = draft({ faq: [{ question: 'Is it waterproof?', answer: 'Yes, to 10m.' }] })
    expect(faqIsConditional(d, true).passed).toBe(true)
  })

  it('fails an FAQ entry with no self-contained answer', () => {
    const d = draft({ faq: [{ question: 'Is it waterproof?', answer: '   ' }] })
    expect(faqIsConditional(d, true).passed).toBe(false)
  })
})

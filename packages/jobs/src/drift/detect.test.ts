import { describe, expect, it } from 'vitest'
import type { ReferencedProductRow } from '@sortiva/db'
import { anyVariantAvailable, detectDrift, sectionHeadingsOf } from './detect'

/**
 * Reading a store's rows as "these published articles have stopped being true",
 * with no database under it.
 */

const NOW = new Date('2026-09-20T00:00:00.000Z')
const OOS_DAYS = 14

function reference(over: Partial<ReferencedProductRow> = {}): ReferencedProductRow {
  return {
    articleId: 'art-1',
    articleTitle: 'Best water bottles',
    articleState: 'published',
    articleDelivery: 'auto',
    articleBody: { intro: 'The {{p1}} is the one.', sections: [], faq: [] },
    refId: 'ref-1',
    placeholderKey: 'p1',
    refType: 'recommendation',
    productId: 'prod-1',
    productTitle: 'Steel bottle 750',
    shopifyProductId: 'shopify-1',
    familyId: 'fam-1',
    variants: [{ available: true, price: 20 }],
    ...over,
  }
}

function detect(over: Partial<Parameters<typeof detectDrift>[0]> = {}) {
  return detectDrift({
    accountId: 'acc-1',
    references: [reference()],
    deletedShopifyIds: new Set(),
    stockMovedAt: new Map(),
    familyAxes: [],
    outOfStockDaysMin: OOS_DAYS,
    now: NOW,
    ...over,
  })
}

describe('what counts as a published article going wrong', () => {
  it('finds nothing wrong with a store that has not changed', () => {
    expect(detect()).toEqual([])
  })

  it('flags an article recommending a product the store withdrew', () => {
    const found = detect({ deletedShopifyIds: new Set(['shopify-1']) })
    expect(found).toHaveLength(1)
    expect(found[0]!.kind).toBe('product_deleted')
    expect(found[0]!.references[0]!.productTitle).toBe('Steel bottle 750')
  })

  it('flags every article that names the withdrawn product, not just the first', () => {
    const found = detect({
      references: [
        reference(),
        reference({ articleId: 'art-2', refId: 'ref-2', articleTitle: 'Bottles for hiking' }),
        reference({ articleId: 'art-3', refId: 'ref-3', articleTitle: 'Office bottles' }),
      ],
      deletedShopifyIds: new Set(['shopify-1']),
    })
    expect(found.map((observation) => observation.articleId).sort()).toEqual([
      'art-1',
      'art-2',
      'art-3',
    ])
  })

  it('gathers every broken mention in one article into one problem', () => {
    const found = detect({
      references: [
        reference(),
        reference({ refId: 'ref-2', placeholderKey: 'p2', productId: 'prod-2', shopifyProductId: 'shopify-2' }),
      ],
      deletedShopifyIds: new Set(['shopify-1', 'shopify-2']),
    })
    expect(found).toHaveLength(1)
    expect(found[0]!.references).toHaveLength(2)
  })

  it('says nothing about a product that merely changed price', () => {
    // A price change reaches the store's change record and never reaches here:
    // the body holds a pointer, not a figure, so there is nothing to correct.
    expect(detect({ references: [reference({ variants: [{ available: true, price: 9 }] })] })).toEqual([])
  })

  it('says nothing about a product that has only just sold out', () => {
    expect(
      detect({
        references: [reference({ variants: [{ available: false, price: 20 }] })],
        stockMovedAt: new Map([['shopify-1', new Date('2026-09-15T00:00:00.000Z')]]),
      }),
    ).toEqual([])
  })

  it('flags one that nobody has been able to buy for a fortnight', () => {
    const found = detect({
      references: [reference({ variants: [{ available: false, price: 20 }] })],
      stockMovedAt: new Map([['shopify-1', new Date('2026-09-01T00:00:00.000Z')]]),
    })
    expect(found).toHaveLength(1)
    expect(found[0]!.kind).toBe('product_out_of_stock')
  })

  it('says nothing when it cannot tell how long the product has been unbuyable', () => {
    expect(
      detect({ references: [reference({ variants: [{ available: false, price: 20 }] })] }),
    ).toEqual([])
  })

  it('does not raise both a withdrawal and a stock problem about the same mention', () => {
    const found = detect({
      references: [reference({ variants: [{ available: false, price: 20 }] })],
      deletedShopifyIds: new Set(['shopify-1']),
      stockMovedAt: new Map([['shopify-1', new Date('2026-08-01T00:00:00.000Z')]]),
    })
    expect(found.map((observation) => observation.kind)).toEqual(['product_deleted'])
  })

  it('flags a comparison whose range no longer differs the way it did', () => {
    const found = detect({
      references: [
        reference({
          articleBody: {
            intro: 'x',
            sections: [
              { heading: 'Selection criteria: by capacity', body: '' },
              { heading: 'Recommended types', body: '' },
            ],
            faq: [],
          },
        }),
      ],
      familyAxes: [{ familyId: 'fam-1', differentiationAxes: ['material'] }],
    })
    expect(found).toHaveLength(1)
    expect(found[0]!.kind).toBe('family_axes_changed')
    expect(found[0]!.axes).toEqual({ writtenWith: ['capacity'], nowIs: ['material'] })
  })

  it('leaves a comparison alone when the range still differs the same way', () => {
    expect(
      detect({
        references: [
          reference({
            articleBody: {
              intro: 'x',
              sections: [{ heading: 'Selection criteria: by capacity', body: '' }],
              faq: [],
            },
          }),
        ],
        familyAxes: [{ familyId: 'fam-1', differentiationAxes: ['capacity'] }],
      }),
    ).toEqual([])
  })

  it('never flags an article whose shape never compared on anything', () => {
    expect(
      detect({ familyAxes: [{ familyId: 'fam-1', differentiationAxes: ['material'] }] }),
    ).toEqual([])
  })
})

describe('reading the store rows', () => {
  it('calls a product buyable when any version of it is', () => {
    expect(anyVariantAvailable([{ available: false }, { available: true }])).toBe(true)
    expect(anyVariantAvailable([{ available: false }])).toBe(false)
    expect(anyVariantAvailable(null)).toBe(false)
  })

  it('reads the headings off a stored draft and shrugs at anything else', () => {
    expect(sectionHeadingsOf({ sections: [{ heading: 'A' }, { heading: 'B' }] })).toEqual(['A', 'B'])
    expect(sectionHeadingsOf({ sections: 'not an array' })).toEqual([])
    expect(sectionHeadingsOf(null)).toEqual([])
  })
})

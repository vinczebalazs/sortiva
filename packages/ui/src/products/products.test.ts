import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MerchantTaskCard } from './MerchantTaskCard'
import { ProductsScreen } from './ProductsScreen'
import {
  fieldLabel,
  filterProducts,
  isShopifyAdminUrl,
  missingSummary,
  productsAwaitingDetails,
  splitTasks,
} from './products'
import type { FamiliesResponse, MerchantTask, ProductsResponse } from './types'

/**
 * What this file holds the screen to.
 *
 * A merchant task has to name what it is blocking and hand the merchant a link
 * into Shopify admin for each product, because the fix happens in their store
 * and never here. A link that is not a Shopify admin address is refused rather
 * than repaired. And the family list stays read-only: no split, no merge, only
 * a way to tell us the grouping is wrong.
 */

const TASK: MerchantTask = {
  opportunityId: '22222222-2222-4222-8222-222222222222',
  blockingTitle: 'Best trail shoes under £80',
  impact: 'high',
  products: [
    {
      id: 'shoe-1',
      title: 'Bowfell Trail Low',
      missingFields: ['lug_depth'],
      shopifyAdminUrl: 'https://example.myshopify.com/admin/products/1',
    },
    {
      id: 'shoe-2',
      title: 'Coniston Trail 2',
      missingFields: ['drop', 'weight_g'],
      shopifyAdminUrl: 'https://admin.shopify.com/store/example/products/2',
    },
  ],
  completedAt: null,
}

const FAMILIES: FamiliesResponse = {
  families: [
    {
      id: 'trail-running',
      label: 'Trail — cushioned',
      memberCount: 44,
      axes: ['stack height', 'width'],
      groupingSource: 'fact_clustering',
      lowConfidence: false,
    },
  ],
}

const DATA: ProductsResponse = {
  richness: { band: 'okay', productsMissingDetails: 6 },
  counts: { products: 214, families: 6 },
  merchantTasks: [TASK],
  products: [
    {
      id: 'shoe-2',
      title: 'Coniston Trail 2',
      familyId: 'trail-running',
      factCount: 2,
      richnessBand: 'sparse',
      missingFields: ['drop', 'lug_depth'],
      lastSyncedAt: '2026-08-30T06:10:00.000Z',
    },
    {
      id: 'shoe-3',
      title: 'Scafell 3 — Wide Fit',
      familyId: 'trail-running',
      factCount: 11,
      richnessBand: 'rich',
      missingFields: [],
      lastSyncedAt: '2026-08-30T06:10:00.000Z',
    },
  ],
  cursor: null,
}

describe('a merchant task is work with a reason attached', () => {
  const html = renderToStaticMarkup(createElement(MerchantTaskCard, { task: TASK }))

  it('names the opportunity it is holding up and what that is worth', () => {
    expect(html).toContain('data-task-blocking')
    expect(html).toContain('Best trail shoes under £80')
    expect(html).toContain('High')
  })

  it('links back to the opportunity itself', () => {
    expect(html).toContain(`href="/opportunities#${TASK.opportunityId}"`)
  })

  it('deep-links every product into Shopify admin', () => {
    expect(html).toContain('href="https://example.myshopify.com/admin/products/1"')
    expect(html).toContain('href="https://admin.shopify.com/store/example/products/2"')
    expect(html).toContain('data-task-product-link="shoe-1"')
    expect(html).toContain('data-task-product-link="shoe-2"')
  })

  it('opens those links away from the app without handing the target our page', () => {
    expect(html).toContain('rel="noreferrer noopener"')
    expect(html).toContain('target="_blank"')
  })

  it('names the missing fields in words rather than as stored keys', () => {
    expect(html).toContain('weight')
    expect(html).not.toContain('weight_g')
  })

  it('says the work is picked up by the next sync, so an absent submit button is not a bug', () => {
    expect(html).toContain('data-task-recheck')
    expect(html).toContain('nothing to submit here')
  })
})

describe('a link that is not a Shopify admin address is refused, never repaired', () => {
  it('accepts the two shapes Shopify admin actually uses', () => {
    expect(isShopifyAdminUrl('https://example.myshopify.com/admin/products/1')).toBe(true)
    expect(isShopifyAdminUrl('https://admin.shopify.com/store/example/products/2')).toBe(true)
  })

  it('refuses another host, plain HTTP, and a script address', () => {
    expect(isShopifyAdminUrl('https://evil.example/admin/products/1')).toBe(false)
    expect(isShopifyAdminUrl('http://example.myshopify.com/admin/products/1')).toBe(false)
    expect(isShopifyAdminUrl('javascript:alert(1)')).toBe(false)
    expect(isShopifyAdminUrl('not a url at all')).toBe(false)
  })

  it('renders the product as plain text rather than as a link we do not trust', () => {
    const html = renderToStaticMarkup(
      createElement(MerchantTaskCard, {
        task: {
          ...TASK,
          products: [
            {
              id: 'shoe-9',
              title: 'Suspicious Shoe',
              missingFields: ['drop'],
              shopifyAdminUrl: 'https://evil.example/admin/products/9',
            },
          ],
        },
      }),
    )
    expect(html).toContain('data-task-product-unlinked="shoe-9"')
    expect(html).not.toContain('evil.example')
  })
})

describe('open tasks lead; completed ones fold away', () => {
  it('separates them', () => {
    const split = splitTasks([TASK, { ...TASK, opportunityId: 'x', completedAt: '2026-08-14T00:00:00.000Z' }])
    expect(split.open).toHaveLength(1)
    expect(split.completed).toHaveLength(1)
  })

  it('counts a product blocking two tasks once', () => {
    expect(productsAwaitingDetails([TASK, TASK]).map((product) => product.id)).toEqual([
      'shoe-1',
      'shoe-2',
    ])
  })

  it('puts the completed ones behind a fold with the date they were done', () => {
    const html = renderToStaticMarkup(
      createElement(ProductsScreen, {
        data: {
          ...DATA,
          merchantTasks: [{ ...TASK, completedAt: '2026-08-14T00:00:00.000Z' }],
        },
        families: FAMILIES,
      }),
    )
    expect(html).toContain('data-products-completed-tasks')
    expect(html).toContain('14 Aug 2026')
    expect(html).not.toContain('data-products-section="tasks"')
  })
})

describe('the families list', () => {
  const html = renderToStaticMarkup(
    createElement(ProductsScreen, { data: DATA, families: FAMILIES }),
  )

  it('is present, read-only, and offers a way to report a wrong grouping', () => {
    expect(html).toContain('data-confirm-section="families"')
    expect(html).toContain('Read-only')
    expect(html).toContain('Report wrong grouping')
  })

  it('shows the member count, the axes and where the grouping came from', () => {
    expect(html).toContain('Trail — cushioned')
    expect(html).toContain('44 products')
    expect(html).toContain('stack height')
    expect(html).toContain('From product facts')
  })

  it('offers no way to split or merge one', () => {
    expect(html.toLowerCase()).not.toContain('>split<')
    expect(html.toLowerCase()).not.toContain('>merge<')
  })
})

describe('the products table', () => {
  it('leaves only the thin ones when the sparse filter is on', () => {
    expect(filterProducts(DATA.products, 'sparse').map((row) => row.id)).toEqual(['shoe-2'])
    expect(filterProducts(DATA.products, 'all')).toHaveLength(2)
  })

  it('summarises what a product does not say, in words', () => {
    expect(missingSummary(DATA.products[0]!)).toBe('missing: drop, lug depth')
    expect(missingSummary(DATA.products[1]!)).toBeNull()
  })

  it('spells out a field name we have no wording for rather than showing the key', () => {
    expect(fieldLabel('material')).toBe('material')
    expect(fieldLabel('waterproof_rating')).toBe('waterproof rating')
  })

  it('renders every product with its family, its facts and its richness band', () => {
    const html = renderToStaticMarkup(
      createElement(ProductsScreen, { data: DATA, families: FAMILIES }),
    )
    expect(html).toContain('data-product-row="shoe-2"')
    expect(html).toContain('data-product-richness="sparse"')
    expect(html).toContain('data-product-richness="rich"')
    expect(html).toContain('Trail — cushioned')
  })
})

describe('nothing on this screen asks the merchant to type a fact into us', () => {
  it('has no input for a product field', () => {
    const html = renderToStaticMarkup(
      createElement(ProductsScreen, { data: DATA, families: FAMILIES }),
    )
    const inputs = html.match(/<input[^>]*>/g) ?? []
    // The only writable control on the page belongs to the report-a-grouping
    // modal, which is closed until the merchant opens it.
    expect(inputs).toEqual([])
  })
})

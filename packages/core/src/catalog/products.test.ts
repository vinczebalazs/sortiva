import { describe, expect, it } from 'vitest'
import {
  classifyProductChange,
  namedOptionAxes,
  productContentChecksum,
  isStaleUpdate,
  toProductRow,
  type ShopifyProduct,
} from './products'
import { intentFor, isKnownTopic, occurredAtOf, subjectIdOf } from './webhooks'

function product(overrides: Partial<ShopifyProduct> = {}): ShopifyProduct {
  return {
    id: 700,
    title: 'Ridgeline Trail Shoe',
    body_html: '<p>A <b>premium</b> trail shoe with a 4mm drop.</p>',
    handle: 'ridgeline-trail-shoe',
    product_type: 'Shoes',
    vendor: 'Ridgeline',
    tags: 'trail, running,  waterproof ',
    updated_at: '2026-06-14T10:00:00+00:00',
    status: 'active',
    variants: [
      { id: 1, title: 'UK 8', sku: 'RTS-8', price: '120.00', compare_at_price: '150.00', inventory_quantity: 3 },
      { id: 2, title: 'UK 9', sku: 'RTS-9', price: '120.00', inventory_quantity: 0 },
    ],
    images: [{ src: 'https://cdn.shopify.com/a.jpg' }],
    ...overrides,
  }
}

describe('reading a product', () => {
  it('keeps what we store and splits the tag string Shopify sends', () => {
    const row = toProductRow(product())
    expect(row.shopifyProductId).toBe('700')
    expect(row.tags).toEqual(['trail', 'running', 'waterproof'])
    expect(row.priceRange).toEqual({ min: 120, max: 120 })
    expect(row.updatedAt?.toISOString()).toBe('2026-06-14T10:00:00.000Z')
    expect(row.variants).toEqual([
      { id: '1', title: 'UK 8', sku: 'RTS-8', price: 120, compareAtPrice: 150, available: true },
      { id: '2', title: 'UK 9', sku: 'RTS-9', price: 120, compareAtPrice: null, available: false },
    ])
  })

  it('keeps the store\'s own option axes, names and values', () => {
    const row = toProductRow(
      product({
        options: [
          { name: 'Size', position: 1, values: ['UK 8', ' UK 9 ', ''] },
          { name: ' ', values: ['ignored'] },
        ],
      }),
    )
    expect(row.options).toEqual([{ name: 'Size', values: ['UK 8', 'UK 9'] }])
  })

  it('says nothing about options when the read did not ask for them', () => {
    // Undefined and empty must stay different all the way to the write: a
    // webhook or a page read that carried no option field must not be able to
    // erase the options a full sync went and fetched.
    expect(toProductRow(product()).options).toBeUndefined()
    expect(toProductRow(product({ options: [] })).options).toEqual([])
  })

  it('drops the option Shopify invents for a product that has none', () => {
    const axes = namedOptionAxes([
      { name: 'Title', values: ['Default Title'] },
      { name: 'Colour', values: ['Black'] },
    ])
    expect(axes.map((axis) => axis.name)).toEqual(['Colour'])
  })

  it('keeps a real option that happens to be called Title', () => {
    const axes = namedOptionAxes([{ name: 'Title', values: ['Mr', 'Mrs'] }])
    expect(axes).toHaveLength(1)
  })

  it('keeps each picture with the words the merchant wrote for it', () => {
    // An article about a product is published with one of its pictures, and the
    // merchant's own description of it becomes the published image's alt text.
    // A picture Shopify is still processing has no address yet, and publishing
    // that would put a broken image on the merchant's blog.
    const row = toProductRow(
      product({
        images: [
          { src: 'https://cdn.shopify.com/a.jpg', alt: 'Side view of the shoe' },
          { src: 'https://cdn.shopify.com/b.jpg', alt: '' },
          { src: '', alt: 'still uploading' },
        ],
      }),
    )
    expect(row.images).toEqual([
      { url: 'https://cdn.shopify.com/a.jpg', alt: 'Side view of the shoe' },
      { url: 'https://cdn.shopify.com/b.jpg', alt: null },
    ])
  })

  it('says nothing about pictures when the read did not ask for them', () => {
    // Same rule as the options: a webhook body carries no pictures, and writing
    // "none" over the ones we hold would strip the images off every product in
    // the store the first time a merchant edited one.
    expect(toProductRow(product({ images: undefined })).images).toBeUndefined()
    expect(toProductRow(product({ images: [] })).images).toEqual([])
  })

  it('keeps the store own structured attributes, which now travel with the product', () => {
    const row = toProductRow(
      product({
        metafields: [
          { namespace: 'specs', key: 'drop_mm', value: 4, type: 'number_integer' },
          { namespace: 'specs', key: 'empty', value: '  ' },
        ],
      }),
    )
    expect(row.metafields).toEqual([
      { namespace: 'specs', key: 'drop_mm', value: '4', type: 'number_integer' },
    ])
  })

  it('says nothing about attributes when the read did not ask for them', () => {
    expect(toProductRow(product()).metafields).toBeUndefined()
    expect(toProductRow(product({ metafields: [] })).metafields).toEqual([])
  })

  it('treats a made-to-order variant as available whatever the count says', () => {
    const row = toProductRow(
      product({ variants: [{ id: 3, inventory_quantity: 0, inventory_policy: 'continue' }] }),
    )
    expect(row.variants[0]?.available).toBe(true)
  })
})

describe('the content fingerprint', () => {
  it('does not move when only the price moves', () => {
    const before = productContentChecksum(product())
    const after = productContentChecksum(
      product({
        variants: [
          { id: 1, title: 'UK 8', sku: 'RTS-8', price: '90.00', inventory_quantity: 3 },
          { id: 2, title: 'UK 9', sku: 'RTS-9', price: '90.00', inventory_quantity: 0 },
        ],
      }),
    )
    // Distillation re-runs when this moves. A sale must not buy a fresh model
    // call for every product in the shop.
    expect(after).toBe(before)
  })

  it('does not move when only the stock moves', () => {
    const before = productContentChecksum(product())
    const after = productContentChecksum(
      product({
        variants: [
          { id: 1, title: 'UK 8', sku: 'RTS-8', price: '120.00', compare_at_price: '150.00', inventory_quantity: 0 },
          { id: 2, title: 'UK 9', sku: 'RTS-9', price: '120.00', inventory_quantity: 0 },
        ],
      }),
    )
    expect(after).toBe(before)
  })

  it('moves when the words move', () => {
    expect(productContentChecksum(product({ body_html: '<p>Rewritten.</p>' }))).not.toBe(
      productContentChecksum(product()),
    )
    expect(productContentChecksum(product({ title: 'Ridgeline Trail Shoe II' }))).not.toBe(
      productContentChecksum(product()),
    )
  })

  it('does not move when Shopify reorders a list', () => {
    const reordered = product({
      variants: [
        { id: 2, title: 'UK 9', sku: 'RTS-9', price: '120.00', inventory_quantity: 0 },
        { id: 1, title: 'UK 8', sku: 'RTS-8', price: '120.00', compare_at_price: '150.00', inventory_quantity: 3 },
      ],
    })
    expect(productContentChecksum(reordered)).toBe(productContentChecksum(product()))
  })
})

describe('working out what changed', () => {
  const stored = () => {
    const row = toProductRow(product())
    return { checksum: row.checksum, updatedAt: row.updatedAt, variants: row.variants }
  }

  it('says nothing changed when nothing changed', () => {
    expect(classifyProductChange(stored(), toProductRow(product()))).toEqual([])
  })

  it('calls a product we have never seen a creation', () => {
    expect(classifyProductChange(undefined, toProductRow(product()))).toEqual(['product_created'])
  })

  it('tells a price change apart from a rewrite', () => {
    const cheaper = toProductRow(
      product({
        variants: [
          { id: 1, title: 'UK 8', sku: 'RTS-8', price: '90.00', compare_at_price: '150.00', inventory_quantity: 3 },
          { id: 2, title: 'UK 9', sku: 'RTS-9', price: '120.00', inventory_quantity: 0 },
        ],
      }),
    )
    expect(classifyProductChange(stored(), cheaper)).toEqual(['price_changed'])
  })

  it('tells a stock change apart from a rewrite', () => {
    const restocked = toProductRow(
      product({
        variants: [
          { id: 1, title: 'UK 8', sku: 'RTS-8', price: '120.00', compare_at_price: '150.00', inventory_quantity: 3 },
          { id: 2, title: 'UK 9', sku: 'RTS-9', price: '120.00', inventory_quantity: 7 },
        ],
      }),
    )
    expect(classifyProductChange(stored(), restocked)).toEqual(['availability_changed'])
  })

  it('reports both when a merchant rewrites and reprices at once', () => {
    const both = toProductRow(
      product({
        body_html: '<p>Rewritten.</p>',
        variants: [
          { id: 1, title: 'UK 8', sku: 'RTS-8', price: '90.00', compare_at_price: '150.00', inventory_quantity: 3 },
          { id: 2, title: 'UK 9', sku: 'RTS-9', price: '90.00', inventory_quantity: 0 },
        ],
      }),
    )
    expect(classifyProductChange(stored(), both)).toEqual(['product_updated', 'price_changed'])
  })
})

describe('deliveries that arrive out of order', () => {
  it('recognises an edit older than the one we already hold', () => {
    const held = new Date('2026-06-14T10:00:00Z')
    expect(isStaleUpdate(held, new Date('2026-06-14T09:00:00Z'))).toBe(true)
    expect(isStaleUpdate(held, new Date('2026-06-14T11:00:00Z'))).toBe(false)
    expect(isStaleUpdate(held, held)).toBe(false)
  })

  it('does not call anything stale when either side has no stamp', () => {
    expect(isStaleUpdate(null, new Date())).toBe(false)
    expect(isStaleUpdate(new Date(), null)).toBe(false)
  })
})

describe('what each Shopify topic means', () => {
  it('routes the catalogue topics into the change stream', () => {
    expect(intentFor('products/create')).toEqual({ kind: 'catalog', events: ['product_created'] })
    expect(intentFor('products/delete')).toEqual({ kind: 'catalog', events: ['product_deleted'] })
    expect(intentFor('collections/create')).toEqual({
      kind: 'catalog',
      events: ['collection_updated'],
    })
    expect(intentFor('collections/update')).toEqual({
      kind: 'catalog',
      events: ['collection_updated'],
    })
  })

  it('subscribes to no topic Shopify does not actually publish', () => {
    // Shopify has no topics for pages or blog posts, so a merchant's edit to
    // either reaches us on the nightly re-read and not before. That is a real
    // gap; listing the topics anyway would only have hidden it.
    expect(isKnownTopic('articles/update')).toBe(false)
    expect(isKnownTopic('pages/delete')).toBe(false)

    // Stock has a topic, but it needs a permission of its own over a merchant's
    // warehouse figures — far more than a writer of articles should ask for. A
    // product going out of stock still reaches us through `products/update`.
    expect(isKnownTopic('inventory_levels/update')).toBe(false)
  })

  it('sends a product edit to be compared rather than assuming what changed', () => {
    expect(intentFor('products/update')).toEqual({ kind: 'catalog_product_compare' })
  })

  it('routes the uninstall and the three privacy requests', () => {
    expect(intentFor('app/uninstalled')).toEqual({ kind: 'connection_lost' })
    expect(intentFor('customers/redact')).toEqual({ kind: 'privacy', request: 'customers_redact' })
    expect(intentFor('customers/data_request')).toEqual({
      kind: 'privacy',
      request: 'customers_data_request',
    })
    expect(intentFor('shop/redact')).toEqual({ kind: 'privacy', request: 'shop_redact' })
  })

  it('refuses a topic nobody has thought about', () => {
    expect(isKnownTopic('orders/create')).toBe(false)
    expect(intentFor('orders/create')).toBeUndefined()
  })
})

describe('reading a webhook body', () => {
  it('finds the subject id, which every body carries at its top level', () => {
    expect(subjectIdOf('products/update', { id: 700 })).toBe('700')
    expect(subjectIdOf('collections/update', { id: 42 })).toBe('42')
    expect(subjectIdOf('products/update', {})).toBeUndefined()
  })

  it('takes the moment from the body, falling back to arrival', () => {
    const arrival = new Date('2026-06-14T12:00:00Z')
    expect(occurredAtOf({ updated_at: '2026-06-14T10:00:00Z' }, arrival)).toBe(
      '2026-06-14T10:00:00.000Z',
    )
    expect(occurredAtOf({}, arrival)).toBe('2026-06-14T12:00:00.000Z')
  })
})

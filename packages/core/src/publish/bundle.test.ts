import { describe, expect, it } from 'vitest'
import {
  BundleNotBuildable,
  buildExportBundle,
  shopifyCdnImagesOnly,
  type BuildBundleInput,
} from './bundle'
import { checkPublishedUrl } from './published-url'
import { resolveProductReferences, type LiveProduct } from './resolve'

/**
 * What a merchant on export mode is handed, and the two things that must never
 * be in it: an image address we cannot account for, and a price that was true
 * some other week.
 */

const BOTTLE: LiveProduct = {
  productId: 'prod-1',
  title: 'Trailblazer 750',
  price: 49.99,
  compareAtPrice: null,
  available: true,
  currency: 'USD',
  url: 'https://shop.example/products/trailblazer-750',
}

function input(over: Partial<BuildBundleInput> = {}): BuildBundleInput {
  return {
    article: {
      title: 'Best water bottles',
      slug: 'best-water-bottles',
      metaDescription: 'How to choose a water bottle.',
      targetKeyword: 'best water bottles',
      body: {
        intro: 'Steel is the right default for most kitchens[[c1]].',
        sections: [{ heading: 'Recommended', body: 'The {{p1}} suits most people.' }],
        faq: [{ question: 'Which size?', answer: 'A 750 ml bottle covers a working day[[c2]].' }],
      },
    },
    references: [
      { placeholderKey: 'p1', productId: 'prod-1', refType: 'recommendation', fieldsRendered: ['price'] },
    ],
    live: new Map([['prod-1', BOTTLE]]),
    images: [],
    ...over,
  }
}

function fileOf(bundle: ReturnType<typeof buildExportBundle>, extension: string): string {
  const file = bundle.files.find((f) => f.filename.endsWith(`.${extension}`))
  if (!file) throw new Error(`no .${extension} in the bundle`)
  return file.content
}

describe('the export bundle', () => {
  it('hands over Markdown, HTML and a metadata block', () => {
    const bundle = buildExportBundle(input())
    expect(bundle.files.map((f) => f.filename)).toEqual([
      'sortiva-best-water-bottles.md',
      'sortiva-best-water-bottles.html',
      'sortiva-best-water-bottles.json',
    ])
    expect(bundle.files.map((f) => f.mimeType)).toEqual(['text/markdown', 'text/html', 'application/json'])
  })

  it('carries the price the store charges now, and no leftover marker', () => {
    const bundle = buildExportBundle(input())
    const markdown = fileOf(bundle, 'md')
    expect(markdown).toContain('49.99 USD')
    expect(markdown).not.toContain('{{p1}}')
    expect(markdown).toMatch(/\[Trailblazer 750 \(49\.99 USD\)\]\(https:\/\/shop\.example\/products\/trailblazer-750\)/)
  })

  /**
   * The done-when in the card: a bundle built after the merchant changed a
   * price carries the new one. Nothing about the article changed — only the
   * store did, and the bundle is built from the store.
   */
  it('follows a price change without the article being touched', () => {
    const before = fileOf(buildExportBundle(input()), 'md')
    expect(before).toContain('49.99 USD')

    const reduced = { ...BOTTLE, price: 39.5, compareAtPrice: 49.99 }
    const after = fileOf(
      buildExportBundle(input({ live: new Map([['prod-1', reduced]]) })),
      'md',
    )
    expect(after).toContain('39.50 USD')
    expect(after).not.toContain('49.99')
  })

  it('takes the writer\'s citation markers back out — they are ours, not the reader\'s', () => {
    const bundle = buildExportBundle(input())
    expect(fileOf(bundle, 'md')).not.toContain('[[c1]]')
    expect(fileOf(bundle, 'html')).not.toContain('[[c2]]')
  })

  it('refuses to build at all when a referenced product has gone', () => {
    expect(() => buildExportBundle(input({ live: new Map() }))).toThrow(BundleNotBuildable)
    try {
      buildExportBundle(input({ live: new Map() }))
    } catch (error) {
      expect((error as BundleNotBuildable).reason).toBe('missing_product')
      expect((error as BundleNotBuildable).placeholders).toEqual(['p1'])
    }
  })

  it('refuses a body carrying a marker no reference explains', () => {
    const broken = input()
    const withStray = {
      ...broken,
      article: {
        ...broken.article,
        body: {
          ...broken.article.body,
          sections: [{ heading: 'Recommended', body: 'The {{p1}} and the {{p9}} both work.' }],
        },
      },
    }
    try {
      buildExportBundle(withStray)
      throw new Error('expected the build to refuse')
    } catch (error) {
      expect((error as BundleNotBuildable).reason).toBe('unresolved_placeholder')
      expect((error as BundleNotBuildable).placeholders).toEqual(['p9'])
    }
  })

  /** Done-when: the bundle contains only `cdn.shopify.com` image addresses. */
  it('passes on only the store\'s own CDN images, and never image bytes', () => {
    const bundle = buildExportBundle(
      input({
        images: [
          { url: 'https://cdn.shopify.com/s/files/1/bottle.jpg', alt: 'Trailblazer 750' },
          { url: 'https://images.rival.example/bottle.jpg', alt: 'Somebody else\'s photo' },
          { url: 'http://cdn.shopify.com/s/files/1/insecure.jpg', alt: 'Plain http' },
          { url: 'data:image/png;base64,AAAA', alt: 'Bytes' },
          { url: 'not a url at all', alt: 'Nonsense' },
        ],
      }),
    )
    const metadata = JSON.parse(fileOf(bundle, 'json')) as { images: { url: string }[] }
    expect(metadata.images.map((i) => i.url)).toEqual(['https://cdn.shopify.com/s/files/1/bottle.jpg'])
    expect(fileOf(bundle, 'json')).not.toContain('base64')
  })

  it('names the on-page metadata the merchant has to fill in', () => {
    const metadata = JSON.parse(fileOf(buildExportBundle(input()), 'json')) as Record<string, unknown>
    expect(metadata.title).toBe('Best water bottles')
    expect(metadata.slug).toBe('best-water-bottles')
    expect(metadata.metaDescription).toBe('How to choose a water bottle.')
    expect(metadata.targetKeyword).toBe('best water bottles')
    expect(metadata.productReferences).toEqual([{ placeholderKey: 'p1', values: { price: '49.99 USD' } }])
  })

  it('escapes the merchant\'s own text in the HTML but leaves the product link a link', () => {
    const bundle = buildExportBundle(
      input({
        article: {
          ...input().article,
          body: {
            intro: 'Bottles & flasks <are> different.',
            sections: [{ heading: 'Recommended', body: 'The {{p1}} suits most people.' }],
            faq: [],
          },
        },
      }),
    )
    const html = fileOf(bundle, 'html')
    expect(html).toContain('Bottles &amp; flasks &lt;are&gt; different.')
    expect(html).toContain('<a href="https://shop.example/products/trailblazer-750">')
  })
})

describe('shopifyCdnImagesOnly', () => {
  it('keeps a subdomain of nothing and an exact host only', () => {
    expect(
      shopifyCdnImagesOnly([
        { url: 'https://cdn.shopify.com/a.jpg', alt: '' },
        { url: 'https://cdn.shopify.com.evil.example/a.jpg', alt: '' },
        { url: 'https://evil.cdn.shopify.com/a.jpg', alt: '' },
      ]).map((i) => i.url),
    ).toEqual(['https://cdn.shopify.com/a.jpg'])
  })
})

describe('resolving a mention', () => {
  it('renders stock and sale state as words, not as codes', () => {
    const { resolved } = resolveProductReferences(
      [
        {
          placeholderKey: 'p1',
          productId: 'prod-1',
          refType: 'mention',
          fieldsRendered: ['price', 'stock', 'sale_status'],
        },
      ],
      new Map([['prod-1', { ...BOTTLE, price: 39.5, compareAtPrice: 49.99, available: false }]]),
    )
    expect(resolved.get('p1')?.values).toEqual({
      price: '39.50 USD',
      stock: 'out of stock',
      sale_status: 'on sale',
    })
  })

  it('renders a product with no address as a name rather than an empty link', () => {
    const { resolved } = resolveProductReferences(
      [{ placeholderKey: 'p1', productId: 'prod-1', refType: 'link', fieldsRendered: ['title'] }],
      new Map([['prod-1', { ...BOTTLE, url: null }]]),
    )
    expect(resolved.get('p1')?.markdown).toBe('Trailblazer 750')
  })

  it('prints a price without a currency rather than guessing one', () => {
    const { resolved } = resolveProductReferences(
      [{ placeholderKey: 'p1', productId: 'prod-1', refType: 'mention', fieldsRendered: ['price'] }],
      new Map([['prod-1', { ...BOTTLE, currency: null }]]),
    )
    expect(resolved.get('p1')?.values.price).toBe('49.99')
  })
})

describe('the address a merchant says they published at', () => {
  it('accepts the claimed domain and a subdomain of it', () => {
    expect(checkPublishedUrl('https://example.com/blog/bottles', 'example.com')).toEqual({
      ok: true,
      url: 'https://example.com/blog/bottles',
    })
    expect(checkPublishedUrl('https://blog.example.com/bottles', 'example.com').ok).toBe(true)
    expect(checkPublishedUrl('https://www.example.com/bottles', 'example.com').ok).toBe(true)
  })

  /** Done-when: an address on another domain is rejected. */
  it('rejects an address on somebody else\'s site', () => {
    expect(checkPublishedUrl('https://rival.example/bottles', 'example.com')).toEqual({
      ok: false,
      problem: 'off_domain',
    })
    // The lookalike that a plain "ends with" test would let through.
    expect(checkPublishedUrl('https://notexample.com/bottles', 'example.com').problem).toBe('off_domain')
  })

  it('rejects something that is not a web address at all', () => {
    expect(checkPublishedUrl('bottles', 'example.com').problem).toBe('malformed')
    expect(checkPublishedUrl('javascript:alert(1)', 'example.com').problem).toBe('malformed')
    expect(checkPublishedUrl('ftp://example.com/x', 'example.com').problem).toBe('malformed')
  })
})

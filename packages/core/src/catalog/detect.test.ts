import { describe, expect, it } from 'vitest'
import { detectPlatform, isShopHandle, signalsFrom } from './detect'
import type { StorePage, StorePageFetcher } from './ports'

/**
 * Detection decides whether a merchant is onboarded or parked, so it is tested
 * against the shapes real storefronts actually have — headers, theme markup, a
 * product feed — and against the sites that look like a shop and are not.
 */

function page(overrides: Partial<StorePage> = {}): StorePage {
  return {
    finalUrl: 'https://example.com/',
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<html><body>hello</body></html>',
    bytes: 30,
    chain: ['https://example.com/'],
    headers: {},
    ...overrides,
  }
}

class FakeFetcher implements StorePageFetcher {
  readonly requested: string[] = []
  private readonly answers = new Map<string, StorePage | Error>()

  on(url: string, result: StorePage | Error): this {
    this.answers.set(url, result)
    return this
  }

  async fetch(request: { url: string }): Promise<StorePage> {
    this.requested.push(request.url)
    const answer = this.answers.get(request.url)
    if (answer === undefined) throw new Error(`no answer for ${request.url}`)
    if (answer instanceof Error) throw answer
    return answer
  }
}

describe('shopify signals in one response', () => {
  it('reads the store id header', () => {
    expect(signalsFrom(page({ headers: { 'x-shopid': '12345' } }))).toContain('shop_id_header')
  })

  it('reads a header that names Shopify', () => {
    expect(signalsFrom(page({ headers: { 'powered-by': 'Shopify' } }))).toContain('response_header')
  })

  it('reads theme assets served from the Shopify CDN', () => {
    const body = '<script src="https://cdn.shopify.com/s/files/1/0001/theme.js"></script>'
    expect(signalsFrom(page({ body }))).toContain('cdn_asset')
  })

  it('reads the storefront object the theme defines', () => {
    expect(signalsFrom(page({ body: '<script>window.Shopify = {};</script>' }))).toContain(
      'window_shopify',
    )
  })

  it('finds nothing in an ordinary site', () => {
    expect(signalsFrom(page({ body: '<html><h1>My handmade candles</h1></html>' }))).toEqual([])
  })
})

describe('detectPlatform', () => {
  it('detects a Shopify store from its homepage alone, without spending a second request', async () => {
    const fetcher = new FakeFetcher().on(
      'https://shop.example.com/',
      page({
        finalUrl: 'https://shop.example.com/',
        headers: { 'x-shopid': '42' },
        body: '<script>window.Shopify = {}; var s="acme-candles.myshopify.com";</script>',
      }),
    )

    const result = await detectPlatform({ fetcher }, 'shop.example.com')

    expect(result.platform).toBe('shopify')
    expect(result.shopHandle).toBe('acme-candles')
    expect(fetcher.requested).toEqual(['https://shop.example.com/'])
  })

  it('falls back to the product feed when the markup gives nothing away', async () => {
    const fetcher = new FakeFetcher()
      .on('https://quiet.example.com/', page({ finalUrl: 'https://quiet.example.com/' }))
      .on(
        'https://quiet.example.com/products.json?limit=1',
        page({ body: '{"products":[{"id":1}]}', contentType: 'application/json' }),
      )
      .on('https://quiet.example.com/admin', new Error('login wall'))

    const result = await detectPlatform({ fetcher }, 'quiet.example.com')

    expect(result.platform).toBe('shopify')
    expect(result.signals).toEqual(['products_json'])
    // No name to address the handshake to, and none invented.
    expect(result.shopHandle).toBeUndefined()
  })

  it('does not accept a page that merely answers at /products.json', async () => {
    const fetcher = new FakeFetcher()
      .on('https://blog.example.com/', page({ finalUrl: 'https://blog.example.com/' }))
      .on(
        'https://blog.example.com/products.json?limit=1',
        page({ body: '{"items":[]}', contentType: 'application/json' }),
      )

    const result = await detectPlatform({ fetcher }, 'blog.example.com')

    expect(result.platform).toBe('custom_unsupported')
    expect(result.signals).toEqual([])
  })

  it('parks a site with no Shopify tells at all', async () => {
    const fetcher = new FakeFetcher()
      .on('https://wordpress.example.com/', page({ body: '<html>wp-content</html>' }))
      .on('https://wordpress.example.com/products.json?limit=1', new Error('404'))

    const result = await detectPlatform({ fetcher }, 'wordpress.example.com')

    expect(result.platform).toBe('custom_unsupported')
  })

  it('reads the store name off the admin redirect when the theme hides it', async () => {
    const fetcher = new FakeFetcher()
      .on(
        'https://custom.example.com/',
        page({ finalUrl: 'https://custom.example.com/', headers: { 'x-shopid': '7' } }),
      )
      .on(
        'https://custom.example.com/admin',
        page({
          finalUrl: 'https://admin.shopify.com/store/custom-goods',
          chain: ['https://custom.example.com/admin', 'https://admin.shopify.com/store/custom-goods'],
        }),
      )

    const result = await detectPlatform({ fetcher }, 'custom.example.com')

    expect(result.shopHandle).toBe('custom-goods')
  })

  it('takes the name straight off a store that never set a custom domain', async () => {
    const fetcher = new FakeFetcher().on(
      'https://acme.myshopify.com/',
      page({ finalUrl: 'https://acme.myshopify.com/', headers: { 'x-shopid': '9' } }),
    )

    const result = await detectPlatform({ fetcher }, 'acme.myshopify.com')

    expect(result.shopHandle).toBe('acme')
  })
})

describe('isShopHandle', () => {
  it('accepts real handles and rejects anything that could reshape a URL', () => {
    expect(isShopHandle('acme-candles')).toBe(true)
    expect(isShopHandle('acme.myshopify.com')).toBe(false)
    expect(isShopHandle('acme/../evil')).toBe(false)
    expect(isShopHandle('-leading-hyphen')).toBe(false)
    expect(isShopHandle('')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { InvalidPreviewUrl, normalisePreviewUrl } from './url'

describe('normalisePreviewUrl', () => {
  it.each([
    ['example.com', 'example.com'],
    ['  example.com  ', 'example.com'],
    ['Example.COM', 'example.com'],
    ['www.example.com', 'example.com'],
    ['WWW.Example.com', 'example.com'],
    ['https://example.com', 'example.com'],
    ['http://example.com/', 'example.com'],
    ['https://www.example.com/collections/all?page=2', 'example.com'],
    ['https://example.com.', 'example.com'],
    ['https://example.com:8443/', 'example.com'],
    ['shop.example.com', 'shop.example.com'],
    ['example.co.uk', 'example.co.uk'],
    ['mystore.myshopify.com', 'mystore.myshopify.com'],
  ])('%s → %s', (input, domain) => {
    expect(normalisePreviewUrl(input).domain).toBe(domain)
  })

  it('keeps a subdomain that is not www, because the preview fetches what was pasted', () => {
    // The domain *claim* folds to eTLD+1 (main §2, T1.4). A preview must not:
    // shop.example.com and example.com can be different websites.
    expect(normalisePreviewUrl('shop.example.com').domain).toBe('shop.example.com')
    expect(normalisePreviewUrl('example.com').domain).toBe('example.com')
  })

  it('always fetches the homepage over https, whatever was pasted', () => {
    expect(normalisePreviewUrl('http://example.com/deep/path').homepageUrl).toBe(
      'https://example.com/',
    )
  })

  it.each([
    '',
    '   ',
    'not a url',
    'ftp://example.com',
    'javascript:alert(1)',
    'localhost',
    'example',
    'https://user:pass@example.com',
    'https://[::1]/',
    'https://exa mple.com',
  ])('rejects %s', (input) => {
    expect(() => normalisePreviewUrl(input)).toThrowError(InvalidPreviewUrl)
  })

  it('rejects an absurdly long input before doing any work', () => {
    expect(() => normalisePreviewUrl(`https://${'a'.repeat(3000)}.com`)).toThrowError(
      InvalidPreviewUrl,
    )
  })
})

describe('preview spend joins to the account that later signs up (main §14.7)', () => {
  // The preview fetches the exact address someone pasted, but a merchant claims
  // the registrable domain. Attributing spend to the exact host would leave a
  // subdomain preview permanently unjoinable to the account it belongs to.
  it.each([
    ['shop.example.co.uk', 'example.co.uk'],
    ['blog.example.com', 'example.com'],
    ['www.example.com', 'example.com'],
    ['example.com', 'example.com'],
  ])('%s is billed to %s', (input, billable) => {
    expect(normalisePreviewUrl(input).billableDomain).toBe(billable)
  })

  it('keeps the exact host for the event property, so abuse is still visible', () => {
    const target = normalisePreviewUrl('shop.example.co.uk')
    expect(target.domain).toBe('shop.example.co.uk')
    expect(target.billableDomain).toBe('example.co.uk')
  })

  it('bills a Shopify-hosted store as one tenant, matching the claim', () => {
    // Two shops on myshopify.com are two businesses, so the claim stops a level
    // lower there — and the billing key has to agree, or the join breaks again.
    expect(normalisePreviewUrl('acme.myshopify.com').billableDomain).toBe('acme.myshopify.com')
  })

  it('falls back to the exact host when no registrable domain resolves', () => {
    // The preview accepts addresses the claim would reject. An unjoinable spend
    // row is better than an unrecorded one.
    const target = normalisePreviewUrl('example.invalidtld')
    expect(target.billableDomain).toBe(target.domain)
  })
})


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

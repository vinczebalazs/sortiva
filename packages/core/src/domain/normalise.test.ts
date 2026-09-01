import { describe, expect, it } from 'vitest'
import { InvalidClaimDomain, MULTI_TENANT_SUFFIXES, normaliseClaimDomain } from './normalise'

/**
 * main §2's normalisation rule, as a table. Invariant 1 is only as strong as
 * this function: the unique index is taken over whatever comes out of here, so
 * two spellings of one business that disagree here are two accounts.
 */

const CASES: ReadonlyArray<{ input: string; expected: string; why: string }> = [
  // The literal worked example in main §2.
  { input: 'https://www.Shop.example.co.uk/about', expected: 'example.co.uk', why: 'main §2' },

  // Lowercase, scheme, www, path, query, fragment, port, trailing dot.
  { input: 'EXAMPLE.COM', expected: 'example.com', why: 'lowercased' },
  { input: 'http://example.com', expected: 'example.com', why: 'scheme stripped' },
  { input: 'https://example.com', expected: 'example.com', why: 'scheme stripped' },
  { input: 'www.example.com', expected: 'example.com', why: '`www.` stripped' },
  { input: 'https://example.com/collections/all', expected: 'example.com', why: 'path stripped' },
  { input: 'https://example.com/?utm_source=x#top', expected: 'example.com', why: 'query stripped' },
  { input: 'https://example.com:8443/', expected: 'example.com', why: 'port is not identity' },
  { input: 'example.com.', expected: 'example.com', why: 'root dot stripped' },
  { input: '  example.com  ', expected: 'example.com', why: 'trimmed' },

  // eTLD+1: the whole point of claiming at the registrable domain (main §2) —
  // one business cannot become two accounts by using two subdomains.
  { input: 'blog.example.com', expected: 'example.com', why: 'eTLD+1' },
  { input: 'shop.example.com', expected: 'example.com', why: 'eTLD+1' },
  { input: 'a.b.c.example.com', expected: 'example.com', why: 'eTLD+1, many labels' },

  // Multi-part public suffixes: the case a hand-rolled "last two labels" rule
  // gets wrong, which is why main §2 names the Public Suffix List.
  { input: 'shop.example.co.uk', expected: 'example.co.uk', why: 'co.uk is a public suffix' },
  { input: 'example.co.uk', expected: 'example.co.uk', why: 'co.uk is a public suffix' },
  { input: 'https://www.example.com.au/x', expected: 'example.com.au', why: 'com.au' },
  { input: 'shop.example.co.jp', expected: 'example.co.jp', why: 'co.jp' },

  // main §2's allowlisted multi-tenant suffix: tenants of *.myshopify.com are
  // genuinely separate businesses, so the claim stops one label lower.
  { input: 'acme.myshopify.com', expected: 'acme.myshopify.com', why: 'main §2 allowlist' },
  { input: 'https://ACME.myshopify.com/admin', expected: 'acme.myshopify.com', why: 'allowlist' },
  { input: 'shop.acme.myshopify.com', expected: 'acme.myshopify.com', why: 'one tenant, not two' },

  // Internationalised domains normalise to one ASCII spelling, so a merchant
  // typing either form claims the same row.
  { input: 'https://café.example.com', expected: 'example.com', why: 'IDN host, ASCII eTLD+1' },
  { input: 'münchen.de', expected: 'xn--mnchen-3ya.de', why: 'punycode is the stored form' },
  { input: 'xn--mnchen-3ya.de', expected: 'xn--mnchen-3ya.de', why: 'same row as the unicode form' },
]

const REJECTED: ReadonlyArray<{ input: string; why: string }> = [
  { input: '', why: 'empty' },
  { input: '   ', why: 'blank' },
  { input: 'not a url', why: 'a space is not a host' },
  { input: 'ftp://example.com', why: 'only http(s)' },
  { input: 'javascript:alert(1)', why: 'only http(s)' },
  { input: 'https://user:pw@example.com', why: 'credentials in the address' },
  { input: '127.0.0.1', why: 'an IP is not a domain' },
  { input: 'http://192.168.1.10/', why: 'an IP is not a domain' },
  { input: 'http://[::1]/', why: 'an IPv6 literal is not a domain' },
  { input: 'localhost', why: 'no public suffix' },
  { input: 'example', why: 'no public suffix' },
  { input: 'com', why: 'a public suffix is not a domain' },
  { input: 'co.uk', why: 'a public suffix is not a domain' },
  { input: 'example.con', why: 'not a real TLD — a typo, not a store' },
  { input: 'myshopify.com', why: 'the platform itself is not a store' },
  { input: 'www.myshopify.com', why: 'the platform itself is not a store' },
]

describe('normaliseClaimDomain (main §2, invariant 1)', () => {
  for (const { input, expected, why } of CASES) {
    it(`${JSON.stringify(input)} → ${expected} (${why})`, () => {
      expect(normaliseClaimDomain(input).normalized).toBe(expected)
    })
  }

  for (const { input, why } of REJECTED) {
    it(`rejects ${JSON.stringify(input)} (${why})`, () => {
      expect(() => normaliseClaimDomain(input)).toThrow(InvalidClaimDomain)
    })
  }

  it('is idempotent: normalising its own output changes nothing', () => {
    for (const { input } of CASES) {
      const once = normaliseClaimDomain(input).normalized
      expect(normaliseClaimDomain(once).normalized).toBe(once)
    }
  })

  it('folds every spelling of one business onto one key', () => {
    const spellings = [
      'example.co.uk',
      'www.example.co.uk',
      'https://shop.example.co.uk/collections/all',
      'HTTP://WWW.EXAMPLE.CO.UK',
      'blog.example.co.uk:8080',
    ]
    expect(new Set(spellings.map((s) => normaliseClaimDomain(s).normalized)).size).toBe(1)
  })

  it('keeps the multi-tenant allowlist to the suffixes main §2 names', () => {
    // A guard on scope, not on style: adding an entry silently changes how
    // every merchant on that platform is claimed.
    expect(MULTI_TENANT_SUFFIXES).toEqual(['myshopify.com'])
  })

  it('does not treat the PSL private section as multi-tenant', () => {
    // `github.io` and `blogspot.com` are in the Public Suffix List's private
    // section. Honouring that section wholesale would silently split thousands
    // of hosts into per-tenant claims; main §2 asks for an allowlist instead.
    expect(normaliseClaimDomain('someone.github.io').normalized).toBe('github.io')
    expect(normaliseClaimDomain('someone.blogspot.com').normalized).toBe('blogspot.com')
  })
})

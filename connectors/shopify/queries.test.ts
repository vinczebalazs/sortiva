import { NoDeprecatedCustomRule, parse, specifiedRules, validate } from 'graphql'
import { describe, expect, it } from 'vitest'
import { pinnedSchema, PINNED_VERSION } from '../../fakes/fake-shopify/schema/pinned.ts'
import * as contract from './contract-queries.ts'
import { ALL_DOCUMENTS as PRODUCT_DOCUMENTS } from './queries.ts'

const ALL_DOCUMENTS = { ...PRODUCT_DOCUMENTS, ...contract }
import { CONFIG } from '../../core/config.ts'
import { requestedCost } from '../../fakes/fake-shopify/graphql.ts'

describe(`every Shopify document is valid against the pinned ${PINNED_VERSION} schema`, () => {
  for (const [name, source] of Object.entries(ALL_DOCUMENTS)) {
    it(`${name} uses only fields that exist and are not deprecated`, () => {
      const errors = validate(pinnedSchema(), parse(source), [...specifiedRules, NoDeprecatedCustomRule])
      expect(errors.map((e) => e.message)).toEqual([])
    })
  }

  it('would catch an unknown field and a deprecated one', () => {
    const bad = parse('{ products(first: 1) { nodes { titel images(first: 1) { nodes { url } } } } }')
    const messages = validate(pinnedSchema(), bad, [...specifiedRules, NoDeprecatedCustomRule]).map((e) => e.message)
    expect(messages.some((m) => m.includes('titel'))).toBe(true)
    expect(messages.some((m) => m.includes('deprecated'))).toBe(true)
  })
})

describe("every document stays under Shopify's documented 1,000-point ceiling at the sizes we send", () => {
  const sizes: Record<string, Record<string, unknown>> = {
    PRODUCTS_PAGE: { first: CONFIG.catalogPageSize },
    COLLECTIONS_PAGE: { first: 100 },
    PAGES_PAGE: { first: 100 },
    BLOGS: { first: 100 },
    ARTICLES_PAGE: { first: 100 },
    RECENT_ARTICLES_WITH_MARKER: { first: 50 },
  }
  for (const [name, source] of Object.entries(ALL_DOCUMENTS)) {
    it(name, () => {
      expect(requestedCost(pinnedSchema(), parse(source), sizes[name] ?? {})).toBeLessThanOrEqual(1000)
    })
  }
})

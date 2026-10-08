import { NoDeprecatedCustomRule, parse, specifiedRules, validate } from 'graphql'
import { describe, expect, it } from 'vitest'
import { pinnedSchema, PINNED_VERSION } from '../../fakes/fake-shopify/schema/pinned.ts'
import { ALL_DOCUMENTS } from './queries.ts'

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

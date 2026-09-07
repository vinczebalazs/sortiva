import { describe, expect, it } from 'vitest'
import en from '../../strings/en.json'
import { t } from './translate'
import { CATALOGS, type StringKey } from './catalog'

/**
 * What every sentence in the catalogue renders to today.
 *
 * This exists ahead of any change to the renderer. Interpolation is one
 * function that every screen, every email and every notification in the product
 * goes through, so a change to it can move a sentence in a place nobody thought
 * to look — including the canonical strings the spec pins verbatim. A test that
 * proves nothing moved is worth more than whatever the change adds.
 *
 * It is deliberately not a stored snapshot file: the point is to render every
 * key through the real translator with real parameters, so a change to the
 * *mechanism* is what fails, and to say which key moved rather than that a blob
 * differs.
 */

const catalogue = en as Record<string, string>
const PLACEHOLDER = /\{(\w+)\}/g

/** A value for every placeholder name in the catalogue, stable across runs. */
function paramsFor(template: string): Record<string, string | number> {
  const params: Record<string, string | number> = {}
  for (const [, name] of template.matchAll(PLACEHOLDER)) {
    // Numbers where the name reads like a count, so a plural-aware renderer
    // would have to make a decision here rather than pass the value through.
    params[name!] = /count|days|weeks|products|pages|urls|fields|clicks|impressions|references|subtopics|competitors|articles|position|volume|share|ratio|n$/i.test(
      name!,
    )
      ? 7
      : `«${name}»`
  }
  return params
}

describe('every sentence the product can show', () => {
  const keys = Object.keys(catalogue)

  it('found a catalogue to check', () => {
    // A guard that silently checks nothing is how several checks in this
    // project came to pass over broken things.
    expect(keys.length).toBeGreaterThan(1000)
  })

  it('renders with every placeholder filled and none left showing', () => {
    const leaking: string[] = []
    for (const key of keys) {
      const rendered = t(key as StringKey, paramsFor(catalogue[key]!))
      if (PLACEHOLDER.test(rendered)) leaking.push(key)
      PLACEHOLDER.lastIndex = 0
    }
    expect(leaking, `these would show a merchant a raw {placeholder}`).toEqual([])
  })

  it('renders each sentence exactly as substituting its parameters would', () => {
    // The behaviour every caller in the product currently relies on, pinned key
    // by key. A renderer change that alters any sentence fails here and names
    // it, rather than being noticed on a screen later.
    const moved: string[] = []
    for (const key of keys) {
      const template = catalogue[key]!
      const params = paramsFor(template)
      const expected = template.replace(PLACEHOLDER, (whole, name: string) =>
        params[name] === undefined ? whole : String(params[name]),
      )
      if (t(key as StringKey, params) !== expected) moved.push(key)
    }
    expect(moved, 'these sentences render differently than plain substitution').toEqual([])
  })

  it('has exactly one catalogue today, which is why plural rules are not yet plural', () => {
    // Worth pinning rather than assuming: English is the only language in the
    // catalogue, so nothing here yet needs the three and four plural forms other
    // languages have. A second catalogue arriving is the moment that changes.
    expect(Object.keys(CATALOGS)).toEqual(['en'])
  })

})

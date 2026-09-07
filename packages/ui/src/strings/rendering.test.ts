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
    // The behaviour every caller in the product relies on, pinned key by key. A
    // renderer change that alters any sentence fails here and names it, rather
    // than being noticed on a screen later.
    //
    // Sentences that state both forms of a count are the deliberate exception —
    // choosing between them is the whole point — and they are held by the
    // plural tests below instead.
    const moved: string[] = []
    for (const key of keys) {
      const template = catalogue[key]!
      if (template.includes(', plural,')) continue
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

/**
 * A number a merchant reads has to be able to be one.
 *
 * This is what the card was for. Twelve sentences said "1 pages" where the card
 * named two, and the difference between those numbers is the whole argument:
 * fixing them one at a time is right until somebody writes the thirteenth. So
 * the rule is enforced on the catalogue rather than remembered.
 */
describe('a sentence that carries a count', () => {
  const catalogueEntries = Object.entries(catalogue)

  /** Placeholder names that hold a quantity, as opposed to a position, a share or a name. */
  const COUNTABLE =
    /^(count|days|weeks|months|products|pages|urls|fields|clicks|impressions|references|subtopics|competitors|articles|topics|items|competing_urls|leader_changes|missing_fields|duplicate_fields|missing_subtopics|opportunities)$/i

  /**
   * `appendixA.opportunityHeadline` is the one known exception and it is not an
   * oversight. It is a canonical string the spec pins verbatim (invariant 24) —
   * Appendix A's own words, which the spec calls the core value proposition —
   * so it reads "We found 1 ways to grow your store organically" for a store
   * whose first scan finds one thing, and **only the founder may reword it**.
   * It is with them. Until they answer it ships as it is, seen rather than
   * missed.
   */
  const CANONICAL_EXCEPTIONS = ['appendixA.opportunityHeadline']

  /**
   * Sentences whose caller never hands them a one.
   *
   * `nextScanPrompt` picks a different sentence entirely for today, tomorrow and
   * no scheduled scan, so the counted form is only ever reached at two or more.
   * They are also quoted copy — the founder chose a relative interval over a
   * named weekday — so rewriting them to say "1 day" would change a product
   * decision to fix a sentence that cannot occur.
   */
  const HANDLED_BY_CALLER = ['opportunities.empty', 'dashboard.growth.empty']

  /**
   * The first draft of this looked only at the word straight after the number,
   * and three sentences walked through it — "{count} page recommendations",
   * "{count} published articles", "{count} product tasks" — because an
   * adjective sat in between, so it reads two words rather than one.
   *
   * Two and not more, deliberately: reading four caught words the number does
   * not govern — "{count} more notices in your notifications" flagged
   * "notifications". The limit is honest rather than complete; a count binding
   * a noun three words away would slip through, and none exists today.
   */
  /**
   * Removes the parts of a sentence that already state both forms, so what is
   * left is the text that has not made a decision. Without this the check
   * flags its own fix: the `other` form legitimately reads "{count} articles".
   */
  function withoutPluralBlocks(template: string): string {
    let out = ''
    for (let i = 0; i < template.length; ) {
      const opener = /^\{\w+,\s*plural,/.exec(template.slice(i))
      if (!opener) {
        out += template[i]
        i += 1
        continue
      }
      let depth = 0
      do {
        if (template[i] === '{') depth += 1
        else if (template[i] === '}') depth -= 1
        i += 1
      } while (i < template.length && depth > 0)
    }
    return out
  }

  function countableRunOns(raw: string): readonly string[] {
    const template = withoutPluralBlocks(raw)
    const offenders: string[] = []
    for (const match of template.matchAll(/\{(\w+)\}((?:\s+[a-z]+){1,2})/g)) {
      const [, name, run] = match
      if (!COUNTABLE.test(name!)) continue
      const words = run!.trim().split(/\s+/)
      const plural = words.find((word) => word.length > 3 && word.endsWith('s') && !word.endsWith('ss'))
      if (plural) offenders.push(`{${name}} … ${plural}`)
    }
    return offenders
  }

  it('found sentences to check, and knows which are countable', () => {
    expect(catalogueEntries.length).toBeGreaterThan(1000)
    expect(countableRunOns('we found {count} ways to grow')).toEqual(['{count} … ways'])
    // The shape that slipped past the first draft: a plural behind an adjective.
    expect(countableRunOns('{count} published articles repaired')).toEqual(['{count} … articles'])
    // A sentence that has already made the decision is not an offender.
    expect(countableRunOns('{count} {count, plural, one {article} other {articles}} went live')).toEqual([])
    expect(countableRunOns('this page sits at position {position} today')).toEqual([])
  })

  it('never states a count beside a word only correct at many', () => {
    const wrong: string[] = []
    for (const [key, template] of catalogueEntries) {
      if (CANONICAL_EXCEPTIONS.includes(key) || HANDLED_BY_CALLER.includes(key)) continue
      for (const phrase of countableRunOns(template)) wrong.push(`${key}: "${phrase}"`)
    }
    expect(
      wrong,
      'these read "1 pages" for a store with one. Write both forms:\n' +
        '  {count, plural, one {page} other {pages}}\n' +
        wrong.join('\n'),
    ).toEqual([])
  })

  it('keeps the caller-handled pair honest — their singular sibling must exist', () => {
    // The exemption is only true while the caller really does branch. If the
    // sibling sentence goes, these stop being exempt and start being bugs.
    for (const key of HANDLED_BY_CALLER) {
      expect(catalogue[`${key}.tomorrow`], `${key}.tomorrow`).toBeDefined()
      expect(catalogue[`${key}.today`], `${key}.today`).toBeDefined()
    }
  })

  it('holds the canonical exception open rather than letting it be forgotten', () => {
    // If the founder rewords it, this fails and the exception comes out — which
    // is the point of listing it rather than excluding the whole family.
    for (const key of CANONICAL_EXCEPTIONS) {
      expect(catalogue[key], `${key} is no longer in the catalogue`).toBeDefined()
      expect(countableRunOns(catalogue[key]!).length).toBeGreaterThan(0)
    }
  })

  it('renders both forms through the real translator, on a real sentence', () => {
    // Asserted on a catalogue string rather than a template invented here: a
    // helper that re-implements the renderer would prove only that the helper
    // works.
    expect(t('opportunities.window.days' as StringKey, { days: 1 })).toContain(' day')
    expect(t('opportunities.window.days' as StringKey, { days: 1 })).not.toContain('days')
    expect(t('opportunities.window.days' as StringKey, { days: 28 })).toContain('days')
  })
})

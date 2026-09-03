import { describe, expect, it } from 'vitest'
import { rules } from '@sortiva/rules'
import { lintMessages, lintRecommendation } from './lints'
import { packFactAddresses } from './pack'
import { PAGE_BODY, fixturePack, fixtureRecommendation } from './testing/fixture'

/**
 * T6.2 done-when: "every `facts_used` resolves in fixture output; a planted
 * duplicate paragraph fails lint".
 */

const config = rules().defaults.gates.optimize_recommendation

describe('OPTIMIZE lints', () => {
  it('passes a recommendation whose every cited address is in the pack', () => {
    const pack = fixturePack()
    const result = lintRecommendation(fixtureRecommendation(), { pack, config })

    const cited = [
      ...fixtureRecommendation().sections.flatMap((s) => s.facts_used),
      ...fixtureRecommendation().faq.flatMap((f) => f.facts_used),
    ]
    const addresses = packFactAddresses(pack)
    for (const address of cited) expect(addresses.has(address), address).toBe(true)

    expect(result.issues).toEqual([])
    expect(result.passed).toBe(true)
  })

  it('fails a citation that names an address the pack never held', () => {
    const result = lintRecommendation(
      fixtureRecommendation({
        faq: [
          {
            q: 'What is it made of?',
            a: 'Full-grain leather, tanned in Italy.',
            facts_used: ['product:prod-ridge/leather'],
          },
        ],
      }),
      { pack: fixturePack(), config },
    )

    expect(result.passed).toBe(false)
    expect(result.issues.map((i) => i.check)).toContain('grounding')
    expect(lintMessages(result)[0]).toMatch(/product:prod-ridge\/leather/)
  })

  it('fails a passage that cites nothing at all', () => {
    const result = lintRecommendation(
      fixtureRecommendation({
        sections: [
          {
            heading: 'Why runners love these',
            suggested_copy: 'Runners everywhere agree these are the most comfortable shoes.',
            facts_used: [],
            gap_source: 'store',
          },
        ],
      }),
      { pack: fixturePack(), config },
    )

    expect(result.issues.some((i) => i.check === 'grounding')).toBe(true)
  })

  it('fails a section that restates a paragraph already on the page', () => {
    const planted = PAGE_BODY.split('\n\n')[0]!
    const result = lintRecommendation(
      fixtureRecommendation({
        sections: [
          {
            heading: 'About the fit',
            suggested_copy: planted,
            facts_used: ['family:fam-trail/axis:width'],
            gap_source: 'store',
          },
        ],
      }),
      { pack: fixturePack(), config },
    )

    expect(result.passed).toBe(false)
    const issue = result.issues.find((i) => i.check === 'duplicate_paragraph')
    expect(issue?.location).toContain('About the fit')
  })

  it('fails a link to a page the store does not have', () => {
    const result = lintRecommendation(
      fixtureRecommendation({
        internal_links: {
          add_from: [],
          add_to: [{ url: 'https://example-store.com/pages/invented', anchor: 'guide' }],
        },
      }),
      { pack: fixturePack(), config },
    )

    expect(result.issues.map((i) => i.check)).toContain('link_target_missing')
  })

  it('accepts a link back to the page being optimised', () => {
    const pack = fixturePack()
    const result = lintRecommendation(
      fixtureRecommendation({
        internal_links: {
          add_from: [{ url: pack.page.url, anchor: 'wide trail shoes' }],
          add_to: [],
        },
      }),
      { pack, config },
    )

    expect(result.issues.filter((i) => i.check === 'link_target_missing')).toEqual([])
  })

  it('fails a title or description past the length the search result shows', () => {
    const result = lintRecommendation(
      fixtureRecommendation({
        title_tag: { current: null, suggested: 'x'.repeat(config.title_max_chars + 1), rationale_key: null },
        meta_description: {
          current: null,
          suggested: 'y'.repeat(config.meta_description_max_chars + 1),
          rationale_key: null,
        },
      }),
      { pack: fixturePack(), config },
    )

    expect(result.issues.map((i) => i.location).sort()).toEqual(['meta_description', 'title_tag'])
  })

  it('fails copy stuffed with the target search', () => {
    const phrase = 'trail running shoes for wide feet'
    const result = lintRecommendation(
      fixtureRecommendation({
        sections: [
          {
            heading: 'Wide fit',
            suggested_copy: `${phrase}. ${phrase}. ${phrase}. Buy ${phrase} today.`,
            facts_used: ['family:fam-trail/axis:width'],
            gap_source: 'store',
          },
        ],
        faq: [],
      }),
      { pack: fixturePack(), config },
    )

    expect(result.issues.map((i) => i.check)).toContain('keyword_stuffing')
  })

  it('does not call a single mention of the search phrase stuffing', () => {
    const result = lintRecommendation(fixtureRecommendation(), { pack: fixturePack(), config })
    expect(result.issues.filter((i) => i.check === 'keyword_stuffing')).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { renderRecommendationHtml, renderRecommendationMarkdown, type RecommendationLabels } from './render'
import { fixturePack, fixtureRecommendation } from './testing/fixture'

/**
 * The download, main §10.4. Every label is passed in — the test supplies its
 * own, which is also how it proves the renderer writes no copy of its own.
 */

const labels: RecommendationLabels = {
  documentTitle: 'DOC_TITLE',
  page: 'PAGE',
  search: 'SEARCH',
  intentNote: 'INTENT',
  titleTag: 'TITLE_TAG',
  metaDescription: 'META',
  headings: 'HEADINGS',
  sections: 'SECTIONS',
  faq: 'FAQ',
  internalLinks: 'LINKS',
  linksFrom: 'LINKS_FROM',
  linksTo: 'LINKS_TO',
  current: 'CURRENT',
  suggested: 'SUGGESTED',
  basedOn: 'BASED_ON',
  notSet: 'NOT_SET',
  headingAdd: 'ADD',
  headingRewrite: 'REWRITE',
  trustLine: 'TRUST_LINE',
}

const input = { recommendation: fixtureRecommendation(), pack: fixturePack(), labels }

describe('recommendation download', () => {
  it('renders every part of the recommendation as Markdown', () => {
    const markdown = renderRecommendationMarkdown(input)

    expect(markdown).toContain('# DOC_TITLE')
    expect(markdown).toContain('https://example-store.com/collections/wide-trail-shoes')
    expect(markdown).toContain('Wide trail running shoes for wide feet | Example Store')
    expect(markdown).toContain('How to measure your forefoot')
    expect(markdown).toContain('What is the Ridge 2E made of?')
    expect(markdown).toContain('TRUST_LINE')
  })

  it('names the evidence behind a suggestion in words, not as an address', () => {
    const markdown = renderRecommendationMarkdown(input)

    expect(markdown).toContain('BASED_ON: Covered by the pages above you: how to measure forefoot width')
    expect(markdown).toContain('Ridge 2E — material')
    expect(markdown).not.toContain('product:prod-ridge/material')
  })

  it('falls back to the address when the pack no longer holds that fact', () => {
    const markdown = renderRecommendationMarkdown({
      ...input,
      recommendation: fixtureRecommendation({
        faq: [{ q: 'Q', a: 'A', facts_used: ['product:gone/material'] }],
      }),
    })

    expect(markdown).toContain('product:gone/material')
  })

  it('escapes page text and suggestions in the HTML download', () => {
    const html = renderRecommendationHtml({
      ...input,
      recommendation: fixtureRecommendation({
        intent_note: 'The page says <script>alert(1)</script> in its opening line.',
      }),
    })

    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html.startsWith('<!doctype html>')).toBe(true)
  })

  it('leaves out a section the recommendation has nothing for', () => {
    const markdown = renderRecommendationMarkdown({
      ...input,
      recommendation: fixtureRecommendation({ faq: [], headings: [] }),
    })

    expect(markdown).not.toContain('## FAQ')
    expect(markdown).not.toContain('## HEADINGS')
  })
})

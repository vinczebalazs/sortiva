import { describe, expect, it } from 'vitest'
import { buildExportBundle, type BuildBundleInput } from './bundle'
import type { LiveProduct } from './resolve'

/**
 * What actually lands in a merchant's shop.
 *
 * The writer produces Markdown and the third quality gate grades it as
 * Markdown — its links, its comparison tables, its lists. The builder used to
 * escape that text and wrap each section in one paragraph tag, so all of it
 * reached the storefront as literal characters: brackets around link text, rows
 * of pipes where a table should be, and every paragraph of a section run
 * together into one. Nobody had ever looked at a published article.
 *
 * So this suite asserts the output a browser would render, element by element,
 * rather than that a function was called. The fixture is one article that
 * exercises each thing the writer is allowed to produce.
 */

const BOTTLE: LiveProduct = {
  productId: 'prod-1',
  title: 'Trailblazer 750',
  price: 49.99,
  compareAtPrice: null,
  available: true,
  currency: 'USD',
  url: 'https://shop.example/products/trailblazer-750',
}

function article(body: {
  intro: string
  sections: { heading: string; body: string }[]
  faq?: { question: string; answer: string }[]
}): BuildBundleInput {
  return {
    article: {
      title: 'Choosing a bottle',
      slug: 'choosing-a-bottle',
      metaDescription: 'How to choose.',
      targetKeyword: 'water bottles',
      body: { intro: body.intro, sections: body.sections, faq: body.faq ?? [] },
    },
    references: [
      { placeholderKey: 'p1', productId: 'prod-1', refType: 'recommendation', fieldsRendered: ['price'] },
    ],
    live: new Map([['prod-1', BOTTLE]]),
    images: [],
  }
}

function html(input: BuildBundleInput): string {
  return buildExportBundle(input).html
}

describe('the HTML a merchant publishes', () => {
  it('renders an internal link as a link, not as brackets and a path', () => {
    const out = html(
      article({
        intro: 'Start with our [sizing guide](/pages/sizing) before you order.',
        sections: [],
      }),
    )
    expect(out).toContain('<a href="/pages/sizing">sizing guide</a>')
    expect(out).not.toContain('[sizing guide]')
  })

  it('renders a comparison table as a table', () => {
    const out = html(
      article({
        intro: 'Here they are.',
        sections: [
          {
            heading: 'Compared',
            body: ['| Bottle | Volume |', '| --- | --- |', '| Trailblazer | 750 ml |'].join('\n'),
          },
        ],
      }),
    )
    expect(out).toContain('<table>')
    expect(out).toContain('<th>Bottle</th>')
    expect(out).toContain('<td>750 ml</td>')
    expect(out).not.toContain('| --- |')
  })

  it('renders a list as a list', () => {
    const out = html(
      article({
        intro: 'Two things matter:',
        sections: [{ heading: 'What matters', body: ['- the lid', '- the mouth'].join('\n') }],
      }),
    )
    expect(out).toContain('<ul>')
    expect(out).toContain('<li>the lid</li>')
  })

  it('keeps a nested list nested', () => {
    // The cosmetic tidy-up used to collapse runs of spaces anywhere, including
    // the indent that makes a nested list nested.
    const out = html(
      article({
        intro: 'Sizes:',
        sections: [
          { heading: 'Sizes', body: ['- bottles', '  - 500 ml', '  - 750 ml'].join('\n') },
        ],
      }),
    )
    expect(out.match(/<ul>/g)).toHaveLength(2)
    expect(out).toContain('<li>500 ml</li>')
  })

  it('separates paragraphs instead of running a section together', () => {
    const out = html(
      article({
        intro: 'One.',
        sections: [{ heading: 'Two paragraphs', body: 'First paragraph.\n\nSecond paragraph.' }],
      }),
    )
    expect(out).toContain('<p>First paragraph.</p>')
    expect(out).toContain('<p>Second paragraph.</p>')
  })

  it('renders emphasis, and headings for every section and question', () => {
    const out = html(
      article({
        intro: 'The **last** is what matters.',
        sections: [{ heading: 'Fit', body: 'Plain.' }],
        faq: [{ question: 'Do they run large?', answer: 'No.' }],
      }),
    )
    expect(out).toContain('<strong>last</strong>')
    expect(out).toContain('<h1>Choosing a bottle</h1>')
    expect(out).toContain('<h2>Fit</h2>')
    expect(out).toContain('<h3>Do they run large?</h3>')
  })

  it('renders a product mention as a link to that product', () => {
    const out = html(article({ intro: 'We like the {{p1}}.', sections: [] }))
    expect(out).toContain('<a href="https://shop.example/products/trailblazer-750">')
    expect(out).toContain('Trailblazer 750')
  })
})

/**
 * The half that matters more than the formatting. This HTML is written into
 * somebody else's shop, and it is built from model output about product copy we
 * did not write.
 */
describe('what the renderer refuses to put in a merchant’s shop', () => {
  it('escapes raw HTML in the source rather than passing it through', () => {
    const out = html(
      article({
        intro: 'Careful: <script>alert(1)</script> and <img src=x onerror=alert(1)>.',
        sections: [],
      }),
    )
    // Asserted as markup rather than as text: the escaped version legitimately
    // contains the characters `onerror=`, as prose a reader sees. What must not
    // exist is a tag or an attribute.
    expect(out).not.toMatch(/<script/i)
    expect(out).not.toMatch(/<img/i)
    expect(out).toContain('&lt;script&gt;')
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('refuses a link carrying a script scheme', () => {
    const out = html(
      article({ intro: 'Press [here](javascript:alert(1)) to win.', sections: [] }),
    )
    // No anchor at all: the refused link stays as the literal text the writer
    // typed, which is ugly and harmless, rather than becoming a control a
    // reader can press.
    expect(out).not.toMatch(/<a\s/i)
    expect(out).not.toMatch(/href=/i)
  })

  it('refuses a data-url link', () => {
    const out = html(
      article({
        intro: 'Read [the terms](data:text/html;base64,PHNjcmlwdD4=).',
        sections: [],
      }),
    )
    expect(out).not.toMatch(/<a\s/i)
    expect(out).not.toMatch(/href=/i)
  })

  it('allows the three things a shop article legitimately links to', () => {
    const out = html(
      article({
        intro: '[Inside](/pages/sizing), [outside](https://example.com/x), [mail](mailto:hi@example.com).',
        sections: [],
      }),
    )
    expect(out).toContain('href="/pages/sizing"')
    expect(out).toContain('href="https://example.com/x"')
    expect(out).toContain('href="mailto:hi@example.com"')
  })

  it('does not invent a link out of a bare address the writer left as text', () => {
    const out = html(article({ intro: 'Our shop is at example.com/shop.', sections: [] }))
    expect(out).not.toContain('<a ')
  })

  it('never carries the writer’s internal claim markers', () => {
    const out = html(article({ intro: 'Steel lasts longer[[c1]].', sections: [] }))
    expect(out).not.toContain('[[c1]]')
  })
})

describe('the download and the post are the same article', () => {
  it('renders the HTML from the same Markdown the merchant is handed', () => {
    const bundle = buildExportBundle(
      article({
        intro: 'See the [guide](/pages/guide).',
        sections: [{ heading: 'Compared', body: '| A | B |\n| --- | --- |\n| 1 | 2 |' }],
      }),
    )
    // Both come from one build: the Markdown file a merchant downloads and the
    // body we post are the same words, which is what stops a downloaded copy
    // and a published copy disagreeing about a price.
    expect(bundle.markdown).toContain('[guide](/pages/guide)')
    expect(bundle.html).toContain('<a href="/pages/guide">guide</a>')
    expect(bundle.html).toContain('<table>')
  })
})

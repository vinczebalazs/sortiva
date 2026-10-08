import { describe, expect, it } from 'vitest'
import { blocks, cardImage, finalMarkdown, renderHtml } from './markup.ts'
import type { EvidencePack } from './pack.ts'

const pack: EvidencePack = {
  storeId: 1,
  topicId: 1,
  language: 'en',
  storeName: 'Fernhill Coffee Supply',
  hosts: ['fernhillcoffee.co.uk'],
  topic: { workingTitle: 't', targetQuery: 'q', searches: null, source: 'discovery' },
  profile: { sells: '', audience: '', tone: 'plain', neverSay: '' },
  products: [
    {
      ref: 'P1',
      id: 11,
      platformId: 'gid://shopify/Product/11',
      title: 'Ceramic Cone Dripper, size 02',
      productType: 'Dripper',
      url: 'https://fernhillcoffee.co.uk/products/ceramic-cone-dripper-02',
      images: [
        { url: 'https://cdn.shopify.com/s/files/1/0601/0001/files/cone-dripper-white.jpg', width: 1200, height: 1200, altText: 'White ceramic cone dripper' },
        { url: 'https://cdn.shopify.com/s/files/1/0601/0001/files/cone-dripper-lifestyle.jpg', width: 1600, height: 900, altText: null },
      ],
      core: true,
    },
    { ref: 'P2', id: 12, platformId: 'gid://shopify/Product/12', title: 'Gooseneck Kettle & Stand', productType: 'Kettle', url: 'https://fernhillcoffee.co.uk/products/gooseneck-kettle', images: [], core: true },
  ],
  facts: [],
  links: [
    { ref: 'P1', kind: 'product', title: 'Ceramic Cone Dripper, size 02', url: 'https://fernhillcoffee.co.uk/products/ceramic-cone-dripper-02' },
    { ref: 'P2', kind: 'product', title: 'Gooseneck Kettle & Stand', url: 'https://fernhillcoffee.co.uk/products/gooseneck-kettle' },
    { ref: 'L1', kind: 'collection', title: 'Pour-over', url: 'https://fernhillcoffee.co.uk/collections/pour-over' },
  ],
}

const SHAPES = {
  'list-heavy': `Cleaning a dripper takes a minute and keeps every cup tasting clean.

## Every day

- Rinse the [dripper](P1) with hot water straight after brewing [F1].
- Tip the used filter and grounds into compost.
- Let it dry upside down.

## Once a week

1. Soak it in warm water with a little washing-up liquid.
2. Scrub the ribs with a soft brush [F2].
3. Rinse twice, then dry.

{{P1}}
`,
  table: `Choosing between two pour-over setups comes down to how many cups you brew.

## Side by side

| | [Cone dripper](P1) | [Kettle](P2) |
|---|---|---|
| Cups | 1 to 4 [F3] | — |
| Material | Porcelain [F1] | Steel [F6] |

{{P1}}

{{P2}}

Both live in our [pour-over range](L1).
`,
  'long-form': `Pour-over coffee is made by pouring hot water over ground coffee in a cone [G].

## Why the pour matters

A slow, steady pour lets the water reach every part of the coffee bed, so the grounds extract evenly. A fast pour digs a channel and the cup turns thin and sour. [G]

### Bloom first

Wet the grounds with a little water and wait. Trapped gas escapes, and the rest of the water can do its job.

> A short pause at the start is the cheapest improvement there is.

## Keeping the kit clean

The **dripper** is dishwasher safe [F5], and the *kettle* only needs a rinse. Read more in our [pour-over collection](L1).
`,
}

describe('rendering', () => {
  for (const [name, markdown] of Object.entries(SHAPES)) {
    it(`${name}: the HTML we send matches its snapshot and keeps the Markdown's structure`, async () => {
      const html = renderHtml(markdown, pack)
      await expect(html).toMatchFileSnapshot(`__snapshots__/${name}.html`)

      const bs = blocks(markdown)
      expect((html.match(/<h2>/g) ?? []).length).toBe(bs.filter((b) => b.kind === 'heading' && b.level === 2).length)
      expect((html.match(/<h3>/g) ?? []).length).toBe(bs.filter((b) => b.kind === 'heading' && b.level === 3).length)
      expect((html.match(/<li>/g) ?? []).length).toBe(bs.filter((b) => b.kind === 'list_item').length)
      expect((html.match(/class="sortiva-product"/g) ?? []).length).toBe(bs.filter((b) => b.kind === 'card').length)
      // No marker, no reference and no address outside the store survives into what the merchant gets.
      for (const out of [html, finalMarkdown(markdown, pack)]) {
        expect(out).not.toMatch(/\[(F\d+|G)\]|\{\{P\d+\}\}|\]\((P|L)\d+\)/)
        for (const m of out.matchAll(/https?:\/\/([^/"\s)]+)/g)) expect(['fernhillcoffee.co.uk', 'cdn.shopify.com']).toContain(m[1])
      }
    })
  }

  it('a table survives with its rows and cells', () => {
    const html = renderHtml(SHAPES.table, pack)
    expect((html.match(/<tr>/g) ?? []).length).toBe(3)
    expect(html).toContain('<a href="https://fernhillcoffee.co.uk/products/ceramic-cone-dripper-02">Cone dripper</a>')
  })

  it('the card takes the image closest to its slot shape, and the first one when sizes are unknown', () => {
    expect(cardImage(pack.products[0]!.images)!.url).toMatch(/lifestyle/)
    expect(cardImage([{ url: 'a', width: null, height: null, altText: null }, { url: 'b', width: 4, height: 3, altText: null }])!.url).toBe('a')
    expect(cardImage([])).toBeNull()
    // Alt text is the product title, and ampersands are escaped.
    expect(renderHtml('{{P2}}\n', pack)).toContain('<strong>Gooseneck Kettle &amp; Stand</strong>')
    expect(renderHtml('{{P1}}\n', pack)).toContain('alt="Ceramic Cone Dripper, size 02"')
  })
})

import { describe, expect, it } from 'vitest'
import { mechanicalChecks, type CheckId, type Draft } from './checks.ts'
import { sentences } from './markup.ts'
import type { EvidencePack } from './pack.ts'

const pack: EvidencePack = {
  storeId: 1,
  topicId: 1,
  language: 'en',
  storeName: 'Fernhill Coffee Supply',
  hosts: ['fernhillcoffee.co.uk', 'fernhill-coffee.myshopify.com'],
  topic: { workingTitle: 'How to use a pour-over dripper', targetQuery: 'pour over coffee', searches: 2400, source: 'discovery' },
  profile: { sells: 'coffee brewing gear', audience: 'home brewers', tone: 'plain', neverSay: 'barista-grade' },
  products: [
    { ref: 'P1', id: 11, platformId: 'gid://shopify/Product/11', title: 'Ceramic Cone Dripper, size 02', productType: 'Dripper', url: 'https://fernhillcoffee.co.uk/products/ceramic-cone-dripper-02', images: [], core: true },
    { ref: 'P2', id: 12, platformId: 'gid://shopify/Product/12', title: 'Gooseneck Kettle', productType: 'Kettle', url: 'https://fernhillcoffee.co.uk/products/gooseneck-kettle', images: [], core: true },
  ],
  facts: [
    { ref: 'F1', id: 101, productRef: 'P1', text: 'The Ceramic Cone Dripper is made from glazed porcelain fired in Arita, Japan.' },
    { ref: 'F2', id: 102, productRef: 'P1', text: 'The Ceramic Cone Dripper fits size 02 cone filters.' },
    { ref: 'F3', id: 103, productRef: 'P1', text: 'The Ceramic Cone Dripper brews 1 to 4 cups.' },
    { ref: 'F4', id: 104, productRef: 'P1', text: 'The Ceramic Cone Dripper weighs 380 g.' },
    { ref: 'F5', id: 105, productRef: 'P1', text: 'The Ceramic Cone Dripper is dishwasher safe.' },
    { ref: 'F6', id: 106, productRef: 'P2', text: 'The Gooseneck Kettle holds 600 ml.' },
    { ref: 'F7', id: 107, productRef: 'P2', text: 'The Gooseneck Kettle works on gas, electric and induction hobs.' },
  ],
  links: [
    { ref: 'P1', kind: 'product', title: 'Ceramic Cone Dripper, size 02', url: 'https://fernhillcoffee.co.uk/products/ceramic-cone-dripper-02' },
    { ref: 'P2', kind: 'product', title: 'Gooseneck Kettle', url: 'https://fernhillcoffee.co.uk/products/gooseneck-kettle' },
    { ref: 'L1', kind: 'collection', title: 'Pour-over', url: 'https://fernhillcoffee.co.uk/collections/pour-over' },
  ],
}

const FILLER =
  'Pour-over brewing rewards a little patience and attention, and the method is easy to learn at home. ' +
  'The water should reach every part of the coffee bed so that the grounds extract evenly from top to bottom. '

const GOOD = `Pour-over coffee is made by pouring hot water slowly over ground coffee in a cone, so it drips through a paper filter into a cup or jug below.

## What you need

The [Ceramic Cone Dripper, size 02](P1) is made from glazed porcelain fired in Arita, Japan [F1]. It fits size 02 cone filters [F2] and brews 1 to 4 cups [F3]. The Ceramic Cone Dripper weighs 380 g [F4], and it is dishwasher safe [F5].

{{P1}}

The Gooseneck Kettle holds 600 ml [F6]. The Gooseneck Kettle works on gas, electric and induction hobs [F7]. Browse the rest of our [pour-over range](L1).

## How to brew

${FILLER.repeat(30)}
`

const draft = (markdown: string, extra: Partial<Draft> = {}): Draft => ({
  title: 'How to make pour-over coffee at home',
  metaDescription: 'A plain guide to pour-over coffee at home: what you need, how to brew it, and how to keep your dripper clean afterwards.',
  slug: 'pour-over-coffee',
  markdown,
  ...extra,
})

function failed(d: Draft): CheckId[] {
  return mechanicalChecks(d, pack).checks.filter((c) => !c.ok).map((c) => c.id)
}

describe('mechanical checks', () => {
  it('a draft that cites its facts, links inside the store and stays in range passes every check', () => {
    expect(failed(draft(GOOD))).toEqual([])
    expect(mechanicalChecks(draft(GOOD), pack).factsCited).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7'])
  })

  it('a sentence naming a product without a fact is an uncited claim', () => {
    const report = mechanicalChecks(draft(GOOD.replace('Browse the rest', 'The Gooseneck Kettle keeps coffee hot for longer. Browse the rest')), pack)
    const claims = report.checks.find((c) => c.id === 'claims_cited')!
    expect(claims.ok).toBe(false)
    expect(claims.problems[0]!.sentence).toMatch(/keeps coffee hot/)
  })

  it('a citation to a fact that does not exist is refused', () => {
    expect(failed(draft(GOOD.replace('Browse the rest', 'The Gooseneck Kettle keeps its heat well [F99]. Browse the rest')))).toContain('claims_cited')
  })

  it('a number no cited fact contains is held, and so is a heading number nothing backs', () => {
    expect(failed(draft(GOOD.replace('brews 1 to 4 cups [F3]', 'brews 1 to 6 cups [F3]')))).toContain('numbers_cited')
    expect(failed(draft(GOOD.replace('## How to brew', '## How to brew in 90 seconds')))).toContain('numbers_cited')
  })

  it('a general-knowledge number goes to the reviewer instead of failing, unless the sentence names a product', () => {
    const general = draft(GOOD.replace('## How to brew\n', '## How to brew\n\nMost guides start from about 60 g of coffee per litre of water [G].\n'))
    const report = mechanicalChecks(general, pack)
    expect(report.checks.every((c) => c.ok)).toBe(true)
    expect(report.generalNumbers).toEqual([{ sentence: 'Most guides start from about 60 g of coffee per litre of water.', numbers: ['60'] }])
    expect(failed(draft(GOOD.replace('## How to brew\n', '## How to brew\n\nThe Gooseneck Kettle should be filled with water at 93 degrees [G].\n')))).toContain('claims_cited')
  })

  it('a citation written after the full stop still belongs to its sentence', () => {
    expect(sentences('It fits size 02 cone filters. [F2] Next sentence.')[0]).toMatchObject({ text: 'It fits size 02 cone filters.', facts: ['F2'] })
  })

  it('links: a pack reference passes, an outside address and an unknown store page fail', () => {
    expect(failed(draft(GOOD.replace('(L1)', '(https://www.example.com/pour-over)')))).toContain('links_internal')
    expect(failed(draft(GOOD.replace('(L1)', '(https://fernhillcoffee.co.uk/pages/secret)')))).toContain('links_internal')
    expect(failed(draft(GOOD + '\nSee www.othershop.com for more.\n'))).toContain('links_internal')
    expect(failed(draft(GOOD.replace('{{P1}}', '{{P9}}')))).toContain('links_internal')
  })

  it('shop voice passes; invented experience does not', () => {
    expect(failed(draft(GOOD + '\nWe stock drippers and kettles for every kind of home setup.\n'))).toEqual([])
    expect(failed(draft(GOOD + '\nWe tested every kettle on the market before choosing.\n'))).toContain('no_experience')
    expect(failed(draft(GOOD + '\nIn our experience a slow pour matters most.\n'))).toContain('no_experience')
    expect(failed(draft(GOOD + '\nI always rinse the filter first.\n'))).toContain('no_experience')
  })

  it('a price anywhere fails', () => {
    expect(failed(draft(GOOD + '\nA good setup costs less than £40 in total.\n'))).toContain('no_price')
    expect(failed(draft(GOOD, { metaDescription: 'Pour-over coffee at home, explained plainly, with a dripper from just 28 GBP and a kettle that suits every hob.' }))).toContain('no_price')
  })

  it('raw HTML from the writer is refused', () => {
    expect(failed(draft(GOOD + '\n<script>alert(1)</script>\n'))).toContain('plain_markdown')
    expect(failed(draft(GOOD.replace('## What you need', '<h2 style="color:red">What you need</h2>')))).toContain('plain_markdown')
  })

  it("the owner's never-say list is enforced", () => {
    expect(failed(draft(GOOD + '\nYou can get barista-grade results at home.\n'))).toContain('never_say')
  })

  it('length, language and the fact floor', () => {
    expect(failed(draft(GOOD.replace(FILLER.repeat(30), FILLER)))).toContain('length')
    const hungarian = 'A kávé főzése nem nehéz, és ha van egy jó csepegtető, akkor az egész folyamat még egyszerűbb lesz. '.repeat(80)
    expect(failed(draft(GOOD.replace(FILLER.repeat(30), hungarian)))).toContain('language')
    const fewFacts = GOOD.replace(' The Ceramic Cone Dripper weighs 380 g [F4], and it is dishwasher safe [F5].', '').replace('The Gooseneck Kettle holds 600 ml [F6]. ', '')
    expect(failed(draft(fewFacts))).toContain('fact_floor')
  })

  it('Hungarian experience claims are caught', () => {
    const hu = { ...pack, language: 'hu' as const }
    const text = 'A csepegtetőt kipróbáltuk otthon, és nagyon tetszett.'
    expect(mechanicalChecks(draft(text), hu).checks.find((c) => c.id === 'no_experience')!.ok).toBe(false)
    expect(mechanicalChecks(draft('Kínálatunkban többféle csepegtető kapható.'), hu).checks.find((c) => c.id === 'no_experience')!.ok).toBe(true)
  })
})

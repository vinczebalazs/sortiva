import { describe, expect, it } from 'vitest'
import { fixture } from '../../scenarios/fixtures/index.ts'
import { canonicalKey } from './canonical.ts'
import { onlyProductListings, possibleOverlaps, sameIntent, storeWideWords, top3, type StorePage } from './check.ts'

function storeOf(name: string) {
  const f = fixture(name) as any
  const pages: StorePage[] = [
    ...(f.pages ?? []).map((p: any) => ({ kind: 'page', title: p.title, handle: p.handle, url: `/pages/${p.handle}`, excerpt: '' })),
    ...(f.blogs ?? []).flatMap((b: any) => (b.articles ?? []).map((a: any) => ({ kind: 'article', title: a.title, handle: a.handle, url: `/blogs/${b.handle}/${a.handle}`, excerpt: '' }))),
  ]
  const titles = [f.shop.name, ...f.products.map((p: any) => p.title), ...pages.map((p) => p.title)]
  return { pages, words: storeWideWords(titles, name.endsWith('-hu') ? 'hu' : 'en') }
}

describe('the word check flags existing pages that might answer a topic, for the model to decide', () => {
  const en = storeOf('blog-en')
  const flagged = (q: string, store = en, lang: 'en' | 'hu' = 'en') => possibleOverlaps([q], lang, store.pages, store.words).map((p) => p.title)
  it('flags a page sharing a meaningful word', () => {
    expect(flagged('choosing a harness for your dog')).toContain('How to choose a dog harness')
    expect(flagged('how to clean a dog leash')).toContain('Dog leash length guide: 4 ft, 6 ft or long line?')
  })
  it('does not flag on words that run through the whole shop', () => {
    expect(en.words.has('dog')).toBe(true)
    expect(flagged('best dog toys')).toEqual([])
  })
  it('looks at every phrasing of a topic', () => {
    expect(possibleOverlaps(['dog chew toys', 'orthopedic bed'], 'en', en.pages, en.words).map((p) => p.title)).toEqual(['Orthopedic dog beds explained'])
  })
  const hu = storeOf('blog-hu')
  it('flags Hungarian word forms of the same word', () => {
    expect(flagged('kerékpárlámpa akkumulátor', hu, 'hu')).toContain('Hogyan válassz kerékpárlámpát?')
  })
})

describe('canonical keys', () => {
  it('ignore word order, plurals, case and filler words', () => {
    expect(canonicalKey('How to choose a dog harness', 'en')).toBe(canonicalKey('dog harnesses: choosing', 'en'))
    expect(canonicalKey('Kamillatea készítése', 'hu')).toBe(canonicalKey('kamillatea készítése', 'hu'))
    expect(canonicalKey('kerékpárlámpát', 'hu')).toBe(canonicalKey('kerékpárlámpa', 'hu'))
  })
})

describe('results pages', () => {
  const page = (url: string, productListing = false) => ({ rank: 1, url, domain: '', title: '', productListing })
  it('the same page with different tracking parameters is the same page', () => {
    const top = (u: string[]) => top3(u.map((url) => page(url)))
    expect(top(['https://www.a.com/x?srsltid=1', 'https://b.com/y/', 'https://c.com/z'])).toEqual(top(['https://a.com/x?srsltid=2', 'https://b.com/y', 'https://c.com/z#top']))
  })
  it('two queries sharing two of their top three pages are one intent', () => {
    expect(sameIntent(['a', 'b', 'c'], ['b', 'a', 'x'])).toBe(true)
    expect(sameIntent(['a', 'b', 'c'], ['a', 'x', 'y'])).toBe(false)
  })
  it('a page of nothing but shop listings is one an article cannot win', () => {
    expect(onlyProductListings([page('a', true), page('b', true)])).toBe(true)
    expect(onlyProductListings([page('a', true), page('b')])).toBe(false)
    expect(onlyProductListings([])).toBe(false)
  })
})

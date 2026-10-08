import { describe, expect, it } from 'vitest'
import { fixture } from '../../scenarios/fixtures/index.ts'
import { canonicalKey } from './canonical.ts'
import { coveringPage, onlyProductListings, sameIntent, storeWideWords, type StorePage } from './check.ts'

function storeOf(name: string) {
  const f = fixture(name) as any
  const pages: StorePage[] = [
    ...(f.pages ?? []).map((p: any) => ({ kind: 'page', title: p.title, handle: p.handle, url: `/pages/${p.handle}` })),
    ...(f.blogs ?? []).flatMap((b: any) => (b.articles ?? []).map((a: any) => ({ kind: 'article', title: a.title, handle: a.handle, url: `/blogs/${b.handle}/${a.handle}` }))),
  ]
  const titles = [f.shop.name, ...f.products.map((p: any) => p.title), ...pages.map((p) => p.title)]
  return { pages, words: storeWideWords(titles, name.endsWith('-hu') ? 'hu' : 'en') }
}

describe('an existing page answers a query only when it covers what the query is about', () => {
  const en = storeOf('blog-en')
  it.each([
    ['how to choose a dog harness', 'How to choose a dog harness'],
    ['choosing a dog harness', 'How to choose a dog harness'],
    ['dog harness size', 'Harness size guide'],
    ['dog leash length', 'Dog leash length guide: 4 ft, 6 ft or long line?'],
  ])('blog-en: "%s" is covered by "%s"', (query, title) => {
    expect(coveringPage(query, 'en', en.pages, en.words)?.title).toBe(title)
  })

  it.each(['how to clean a dog leash', 'what size dog bed', 'dog bed vs blanket', 'how to wash a dog blanket'])('blog-en: "%s" is not covered just because it shares "dog" and a product word', (query) => {
    expect(coveringPage(query, 'en', en.pages, en.words)).toBeNull()
  })

  const hu = storeOf('blog-hu')
  it.each([
    ['hogyan válassz kerékpárlámpát', 'Hogyan válassz kerékpárlámpát?'],
    ['kerékpárlámpát hogyan válassz', 'Hogyan válassz kerékpárlámpát?'],
    ['u-lakat vagy láncos zár', 'U-lakat vagy láncos zár: melyik a biztonságosabb?'],
  ])('blog-hu: "%s" is covered by "%s"', (query, title) => {
    expect(coveringPage(query, 'hu', hu.pages, hu.words)?.title).toBe(title)
  })

  it.each(['kerékpárlámpa akkumulátor üzemidő', 'u-lakat helyes használata', 'sárgaréz kerékpárcsengő'])('blog-hu: "%s" is not covered', (query) => {
    expect(coveringPage(query, 'hu', hu.pages, hu.words)).toBeNull()
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

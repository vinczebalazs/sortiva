import { CONFIG, type Language } from '../config.ts'
import type { RankingPage } from '../demand.ts'
import { contentWords, foldAccents } from './canonical.ts'

export type StorePage = { kind: string; title: string; handle: string; url: string; excerpt: string }

/**
 * Existing articles and pages that might already answer this query: they share at least one
 * meaningful word with it, in the title or the address. Deliberately loose; the model makes the
 * final call (overlap.ts). Collections are left out on purpose: they are the store's product
 * listings, which an article links to rather than competes with.
 */
export function possibleOverlaps(queries: string[], language: Language, pages: StorePage[], storeWords: Set<string>): StorePage[] {
  const wanted = new Set(queries.flatMap((q) => contentWords(q, language)).map(foldAccents).filter((w) => !storeWords.has(w)))
  if (!wanted.size) return []
  return pages.filter((page) => {
    if (page.kind !== 'article' && page.kind !== 'page') return false
    const words = [...contentWords(page.title, language), ...contentWords(page.handle.replace(/-/g, ' '), language)].map(foldAccents)
    return words.some((w) => wanted.has(w))
  })
}

/**
 * Words that run through the whole store, such as "dog" in a dog shop: they appear in a large share
 * of its product and page titles, so sharing one says nothing about whether two titles mean the same.
 */
export function storeWideWords(titles: string[], language: Language): Set<string> {
  const counts = new Map<string, number>()
  for (const title of titles) for (const w of new Set(contentWords(title, language).map(foldAccents))) counts.set(w, (counts.get(w) ?? 0) + 1)
  return new Set([...counts].filter(([, n]) => n >= 2 && n / titles.length >= CONFIG.topics.storeWideWordShare).map(([w]) => w))
}

// Google appends tracking parameters (?srsltid=…) that differ between searches for the same page.
const normaliseUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/i, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()

export function top3(pages: RankingPage[]): string[] {
  return pages.slice(0, 3).map((p) => normaliseUrl(p.url))
}

/** Two queries Google answers with mostly the same top three pages are one intent. */
export function sameIntent(a: string[], b: string[]): boolean {
  if (a.length < 3 || b.length < 3) return false
  return a.filter((url) => b.includes(url)).length >= CONFIG.topics.sharedTop3ForSameIntent
}

/** Every ranking page is a shop listing: a buyer is shopping, and an article will not rank there. */
export function onlyProductListings(pages: RankingPage[]): boolean {
  return pages.length > 0 && pages.every((p) => p.productListing)
}

/** Higher is better. Demand counts most; facts and room on the results page temper it. */
export function rankScore(input: { searches: number; distinctFacts: number; pages: RankingPage[] }): number {
  const { factsForFullScore } = CONFIG.topics
  const demand = Math.log10(1 + input.searches)
  const facts = 0.5 + 0.5 * Math.min(input.distinctFacts, factsForFullScore) / factsForFullScore
  const room = input.pages.length ? 0.5 + 0.5 * (input.pages.filter((p) => !p.productListing).length / input.pages.length) : 1
  return demand * facts * room
}

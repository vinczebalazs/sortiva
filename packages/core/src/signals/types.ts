import type { EvidenceFact, IntentClass } from '../contracts/opportunities'

/**
 * What a detector produces, and what it deliberately does not.
 *
 * A detection says "here is something true about this store, and here are the
 * measurements behind it". It never says what to do about it. Choosing between
 * improving a page, rewriting it, fixing something technical or holding off is
 * a separate decision taken later against the whole picture, because the same
 * observation warrants different work depending on what else is true — a page
 * losing traffic because it went stale wants a rewrite; the same page losing
 * traffic because Google stopped indexing it wants the indexing fixed, and
 * rewriting it would waste the effort. Nothing in this module names an action,
 * and `no-action-mapping.test.ts` fails if that changes.
 */

/** The kinds of thing a page can be, as the inventory holds them. */
export type StorePageType =
  | 'collection'
  | 'product'
  | 'page'
  | 'blog_article'
  | 'article_ours'
  | 'other'

/** One of the store's own pages, as detection needs to know it. */
export interface PageFact {
  readonly url: string
  readonly pageType: StorePageType
  /**
   * What the searcher landing here is trying to do. Null where nothing has
   * worked it out yet, which today is every page: the column exists and no
   * code writes it. Detectors treat null as "unknown", never as "no".
   */
  readonly intentClass: IntentClass | null
}

export type PageIndex = ReadonlyMap<string, PageFact>

/**
 * Trailing-slash and fragment differences are the two ways the same page
 * arrives under two spellings — Search Console reports what was in the results
 * page, the inventory reports what the storefront calls it. Nothing else is
 * touched: a query string on a store URL is usually a genuinely different page
 * (a filtered collection, page two of a listing) and collapsing those would
 * merge pages that rank separately.
 */
export function normalisePageUrl(url: string): string {
  const withoutFragment = url.split('#')[0] ?? url
  if (withoutFragment.length > 1 && withoutFragment.endsWith('/')) {
    return withoutFragment.slice(0, -1)
  }
  return withoutFragment
}

export function indexPages(pages: readonly PageFact[]): PageIndex {
  const out = new Map<string, PageFact>()
  for (const page of pages) out.set(normalisePageUrl(page.url), page)
  return out
}

/** The stretch of days a detection was made over. */
export interface DetectionWindow {
  /** Inclusive, `YYYY-MM-DD`. */
  readonly startDate: string
  /** Inclusive, `YYYY-MM-DD`. */
  readonly endDate: string
  readonly days: number
}

/**
 * The token an evidence fact carries to say what period it covers. The words
 * a merchant reads ("Search Console, last 28 days") are produced from this at
 * render time, in the strings package, so a copy change never means rewriting
 * stored evidence.
 */
export function windowToken(window: DetectionWindow): string {
  return `${window.days}d`
}

/** The same length of window, some number of weeks further back. */
export function earlierWindowToken(window: DetectionWindow, offsetWeeks: number): string {
  return `${window.days}d_before_${offsetWeeks}w`
}

/** Everything Search Console told us, as opposed to anything we inferred. */
export const GSC_SOURCE = 'gsc'
/** The store's own account of what it publishes, from `store_pages`. */
export const INVENTORY_SOURCE = 'content_inventory'

export interface FactInput {
  readonly key: string
  readonly value: string | number
  readonly source?: string
  readonly window?: string
}

/**
 * Builds the evidence list. Every fact is stamped with when we read the data,
 * because a card that cannot say how old its numbers are cannot be shown at
 * all — the merchant is being asked to trust a measurement, and a measurement
 * without a date is an opinion.
 */
export function facts(fetchedAt: string, entries: readonly FactInput[]): EvidenceFact[] {
  return entries.map((entry) => ({
    key: entry.key,
    value: entry.value,
    source: entry.source ?? GSC_SOURCE,
    ...(entry.window ? { window: entry.window } : {}),
    fetchedAt,
  }))
}

/**
 * What every detector returns.
 *
 * `unknownPages` is not an error channel — it is how a URL-shape mismatch
 * between what Google reports and what the store told us shows up as a number
 * somebody can see, instead of as signals that quietly stop being found.
 */
export interface DetectionResult<T> {
  readonly detections: readonly T[]
  readonly unknownPages: readonly string[]
}

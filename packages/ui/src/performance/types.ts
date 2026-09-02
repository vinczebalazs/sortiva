/**
 * The two response bodies the Performance screens read, written out here rather
 * than derived from the API's zod schemas — the same arrangement the
 * Opportunities and Content screens use. The schemas are the contract; this is
 * one consumer's view of it, and keeping them apart is what lets a chart be
 * drawn in a test from six hand-made days with no validation library in the
 * browser bundle. The screen contract beside this folder is what stops the two
 * drifting.
 */

/**
 * One day of search data.
 *
 * **A day we have no data for arrives as null and stays null.** Search Console
 * loses days — an outage on their side, a property re-verified, our own sync
 * failing — and a nought in place of a missing day is a lie that reads as a
 * collapse in traffic. The chart breaks its line rather than joining across.
 */
export interface PerformanceDay {
  readonly date: string
  readonly clicks: number | null
  readonly impressions: number | null
}

/**
 * Something we did, on the day we did it, drawn across the chart so the merchant
 * can see whether it moved anything. Three kinds: the day Search Console was
 * connected (everything before it is invisible to us), the day an article went
 * out, and the day a page improvement was marked applied.
 */
export type MarkerKind = 'gsc_connected' | 'article_published' | 'optimize_applied'

export interface PerformanceMarker {
  readonly date: string
  readonly kind: MarkerKind
  readonly label: string
}

/**
 * A verdict on one article or one improved store page.
 *
 * `unrated` is not a bad result — it is no result yet. Nothing is judged before
 * the measurement window is up, because scoring a young page measures noise, so
 * an article published last Tuesday reads as too new rather than as a failure.
 * The rated labels are relative to this store's own median and never to an
 * absolute number of clicks.
 */
export type ResultLabel =
  | 'unrated'
  | 'winner'
  | 'neutral'
  | 'underperformer'
  | 'improved'
  | 'worse'
  | 'recovered'
  | 'not_applied'

export interface PerformanceResult {
  readonly kind: 'article' | 'page'
  readonly id: string
  readonly title: string
  readonly clicks: number
  readonly impressions: number
  readonly position: number
  readonly trend: 'up' | 'flat' | 'down'
  /** A label we have no wording for is shown as itself rather than hidden. */
  readonly label: string
  readonly publishedViaOverride: boolean
}

export interface PerformanceOverview {
  readonly connected: boolean
  readonly series: readonly PerformanceDay[]
  readonly markers: readonly PerformanceMarker[]
  readonly results: readonly PerformanceResult[]
}

export type SearchConsoleDimension = 'query' | 'page'

export type SearchConsoleWindow = '28d' | '3m' | '12m'

export type PageType = 'collection' | 'product' | 'page' | 'blog' | 'our_article'

/** An open opportunity on this row, and the way into it. */
export interface RowSignal {
  readonly signalType: string
  readonly opportunityId: string
}

export interface SearchConsoleRow {
  /** The query itself, or the page's path — whichever dimension was asked for. */
  readonly key: string
  readonly clicks: number
  readonly impressions: number
  readonly ctr: number
  readonly position: number
  readonly deltaClicks: number
  /** Negative is an improvement: position 12 → 8 is −4. */
  readonly deltaPosition: number
  readonly pageType: PageType | null
  readonly signals: readonly RowSignal[]
}

export interface SearchConsoleResponse {
  readonly rows: readonly SearchConsoleRow[]
  readonly cursor: string | null
}

import type { EventAttribution } from './analytics'

/**
 * The SEO data vendor behind an interface of our own, so it is swappable and
 * mockable. Every request is a **billable read**: cached on the endpoint plus
 * canonicalised params, written before the response is processed, and recorded
 * with its cost.
 *
 * All calls are job-side. None may sit in a request path, where a slow vendor
 * would become a slow page.
 */

export interface SeoLocale {
  /** The store's main language, e.g. `da`. Passed as the vendor's language parameter, so a wrong value silently buys the wrong market's numbers. */
  readonly languageCode: string
  /** ISO-3166 alpha-2, e.g. `DK`. Passed as the vendor's location parameter. */
  readonly countryCode: string
}

export interface KeywordMetricsRequest {
  readonly keywords: readonly string[]
  readonly locale: SeoLocale
  readonly attribution: EventAttribution
}

export interface KeywordMetric {
  readonly keyword: string
  /** Average monthly searches. Compared against the demand floor in `packages/rules`, never here. */
  readonly monthlySearchVolume: number | null
  readonly competition: number | null
  readonly cpcUsd: number | null
  /** Twelve months of volume, oldest first, where the vendor supplies it. */
  readonly monthlyHistory: readonly number[]
}

export interface SerpRequest {
  readonly keyword: string
  readonly locale: SeoLocale
  /** How many organic results to retrieve. The caller's card owns the number. */
  readonly depth: number
  readonly attribution: EventAttribution
}

export interface SerpResult {
  readonly position: number
  readonly url: string
  readonly domain: string
  readonly title: string | null
}

export interface RankedKeywordsRequest {
  /** A competitor domain, already normalised. */
  readonly target: string
  readonly locale: SeoLocale
  readonly limit: number
  readonly attribution: EventAttribution
}

export interface RankedKeyword {
  readonly keyword: string
  readonly position: number
  readonly url: string
  readonly monthlySearchVolume: number | null
}

/** What one provider call cost and where it came from — the input to the cost events and the spend ledger. */
export interface SeoCallMeta {
  readonly endpoint: string
  readonly cacheHit: boolean
  /** False on a cache hit: a replay is not a billable read. */
  readonly billable: boolean
  /** From the endpoint-to-price map. Zero on a cache hit, which is recorded rather than omitted. */
  readonly usdCost: number
}

export interface SeoResult<T> {
  readonly data: T
  readonly meta: SeoCallMeta
}

export interface SeoDataProvider {
  keywordMetrics(request: KeywordMetricsRequest): Promise<SeoResult<readonly KeywordMetric[]>>
  serpTop(request: SerpRequest): Promise<SeoResult<readonly SerpResult[]>>
  rankedKeywords(request: RankedKeywordsRequest): Promise<SeoResult<readonly RankedKeyword[]>>
}

import type { EventAttribution } from './analytics'

/**
 * main §12.1 — "Wrap it behind an internal `SeoDataProvider` interface so the
 * vendor is swappable and mockable in tests." Every request is a **billable
 * read** (§14.3.6): request-level cache keyed on the endpoint plus canonicalised
 * params, written before the response is processed, and a `dataforseo_request`
 * event carrying `usd_cost` (§14.7).
 *
 * All calls are job-side; §12.1 forbids them in a request/response path.
 */

export interface SeoLocale {
  /** Persona `main_language`, e.g. `da`. Passed as the vendor's language parameter (§12.1). */
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

/** What one provider call cost and where it came from — the input to §14.7's cost events. */
export interface SeoCallMeta {
  readonly endpoint: string
  readonly cacheHit: boolean
  /** False on a cache hit: a replay is not a billable read. */
  readonly billable: boolean
  /** From the endpoint→price map. Zero on a cache hit (main §14.7). */
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

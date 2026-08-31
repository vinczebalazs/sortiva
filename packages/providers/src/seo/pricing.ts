/**
 * main §14.7 — "`usd_cost` comes from a config table mapping endpoint → unit
 * price (DataForSEO bills different amounts per endpoint — SERP vs. keyword-data
 * vs. ranked-keywords). The price map is config, reviewed when DataForSEO
 * changes pricing."
 *
 * This is that table. It is deliberately *not* in `packages/rules`: invariant 9
 * governs product thresholds (search volume, position, CTR) that decide what
 * Sortiva does. These are a vendor's list prices — an external fact we record,
 * not a decision we make.
 *
 * **UNSIGNED.** The values below are starting figures, not confirmed against a
 * current DataForSEO price list. They set the scale for the §14.5 daily spend
 * cap and for cost-per-domain reporting; both are wrong in proportion if these
 * are. Verify before the first production spend.
 */

export interface EndpointPrice {
  /** USD billed per task (one request), before any per-row charge. */
  readonly perTaskUsd: number
  /** USD billed per returned row, where the endpoint charges by result volume. */
  readonly perRowUsd: number
  readonly note: string
}

export const DATAFORSEO_ENDPOINTS = {
  keywordMetrics: 'keywords_data/google_ads/search_volume/live',
  serpOrganic: 'serp/google/organic/live/advanced',
  rankedKeywords: 'dataforseo_labs/google/ranked_keywords/live',
} as const

export type SeoEndpoint = (typeof DATAFORSEO_ENDPOINTS)[keyof typeof DATAFORSEO_ENDPOINTS]

export const ENDPOINT_PRICES: Record<string, EndpointPrice> = {
  [DATAFORSEO_ENDPOINTS.keywordMetrics]: {
    perTaskUsd: 0.05,
    perRowUsd: 0,
    note: 'Google Ads search volume, live. Billed per task regardless of keyword count. UNSIGNED.',
  },
  [DATAFORSEO_ENDPOINTS.serpOrganic]: {
    perTaskUsd: 0.002,
    perRowUsd: 0,
    note: 'Live Advanced organic SERP. Billed per task. UNSIGNED.',
  },
  [DATAFORSEO_ENDPOINTS.rankedKeywords]: {
    perTaskUsd: 0.011,
    perRowUsd: 0.0001,
    note: 'Labs ranked keywords. Task charge plus a per-row charge. UNSIGNED.',
  },
}

/**
 * An endpoint with no price entry costs *something*, and reporting it as zero
 * would quietly under-count spend — which is exactly what the §14.5 cap exists
 * to catch. Fail loudly instead.
 */
export function priceFor(endpoint: string, rows: number): number {
  const price = ENDPOINT_PRICES[endpoint]
  if (!price) {
    throw new Error(
      `No price configured for DataForSEO endpoint "${endpoint}". Add it to ENDPOINT_PRICES — an unpriced endpoint would report zero cost and defeat the §14.5 spend cap.`,
    )
  }
  const total = price.perTaskUsd + price.perRowUsd * Math.max(0, rows)
  return Math.round(total * 1_000_000) / 1_000_000
}

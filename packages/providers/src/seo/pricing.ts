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

/** What one call costs, and whether we actually know that. */
export interface EndpointCharge {
  readonly usdCost: number
  /**
   * False when the endpoint has no price entry. The call still happened and was
   * still billed, so it is recorded at zero with this flag rather than thrown
   * away — see `chargeFor`.
   */
  readonly priceKnown: boolean
}

/**
 * Audit `docs/audits/T0.5.md` finding 10. The previous version threw here, at
 * request time — which is *after* DataForSEO has been called and billed and
 * *before* the cost record is emitted, so the guard against under-counting
 * caused an under-count and turned a successful paid call into a job failure.
 *
 * The hard failure now happens at module load (`assertEndpointsPriced` below),
 * where a missing price is what it actually is: a deployment mistake, caught
 * before a penny is spent. At request time an unpriced endpoint is recorded at
 * zero and flagged, so it shows up in the ledger as a suspicious free non-replay
 * (`usd_cost = 0` with `cache_hit = false`) instead of vanishing.
 */
export function chargeFor(endpoint: string, rows: number): EndpointCharge {
  const price = ENDPOINT_PRICES[endpoint]
  if (!price) return { usdCost: 0, priceKnown: false }
  const total = price.perTaskUsd + price.perRowUsd * Math.max(0, rows)
  return { usdCost: Math.round(total * 1_000_000) / 1_000_000, priceKnown: true }
}

/** The charge as a plain number. Zero for an unpriced endpoint — use `chargeFor` to tell the two apart. */
export function priceFor(endpoint: string, rows: number): number {
  return chargeFor(endpoint, rows).usdCost
}

/**
 * Every endpoint we can call must have a price, or the §14.5 spend cap is
 * reading a number that is wrong by an unknown amount. Runs when this module
 * loads, so the process refuses to start rather than discovering it mid-job.
 */
export function assertEndpointsPriced(
  endpoints: readonly string[] = Object.values(DATAFORSEO_ENDPOINTS),
  prices: Record<string, EndpointPrice> = ENDPOINT_PRICES,
): void {
  const unpriced = endpoints.filter((endpoint) => !prices[endpoint])
  if (unpriced.length > 0) {
    throw new Error(
      `No price configured for DataForSEO endpoint(s) ${unpriced.map((e) => `"${e}"`).join(', ')}. Add them to ENDPOINT_PRICES — an unpriced endpoint reports zero cost and defeats the §14.5 spend cap.`,
    )
  }
}

assertEndpointsPriced()

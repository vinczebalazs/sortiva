// From the account's own price list (GET /v3/appendix/user_data, free), read 2026-10-08.
// The ledger stores what DataForSEO reports per call; these are the estimates checked against the cap beforehand.
export const ENDPOINTS = {
  searchVolume: 'keywords_data/google_ads/search_volume/live',
  topResults: 'serp/google/organic/live/advanced',
} as const

export type Endpoint = (typeof ENDPOINTS)[keyof typeof ENDPOINTS]

export const PRICE_USD: Record<Endpoint, number> = {
  // Per request, for up to 1,000 keywords.
  [ENDPOINTS.searchVolume]: 0.09,
  // Per request at depth 10.
  [ENDPOINTS.topResults]: 0.002,
}

// Volumes are monthly figures; results move faster. Older answers are fetched again, never served (rule 8).
export const MAX_AGE_DAYS: Record<Endpoint, number> = {
  [ENDPOINTS.searchVolume]: 30,
  [ENDPOINTS.topResults]: 7,
}

export const SERP_DEPTH = 10

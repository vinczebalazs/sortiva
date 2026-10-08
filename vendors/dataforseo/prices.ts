// From the account's own price list (GET /v3/appendix/user_data, free), read 2026-10-08.
// The ledger stores what DataForSEO reports per call; these are the estimates checked against the cap beforehand.
export const ENDPOINTS = {
  searchVolume: 'keywords_data/google_ads/search_volume/live',
  // Top ten through the queue: submitted, then collected. The live variant answers this account only with
  // "50000 Internal Server Error" (2026-10-08); the founder chose the queue, which is also cheaper.
  topResultsPost: 'serp/google/organic/task_post',
  topResultsGet: 'serp/google/organic/task_get/advanced',
} as const

export type Endpoint = (typeof ENDPOINTS)[keyof typeof ENDPOINTS]

export const PRICE_USD = {
  // Per request, for up to 1,000 keywords.
  [ENDPOINTS.searchVolume]: 0.09,
  // Per task at normal priority and depth 10; collecting it is free.
  [ENDPOINTS.topResultsPost]: 0.0006,
} as const

// Volumes are monthly figures; results move faster. Older answers are fetched again, never served (rule 8).
export const MAX_AGE_DAYS = {
  [ENDPOINTS.searchVolume]: 30,
  [ENDPOINTS.topResultsPost]: 7,
} as const

export const SERP_DEPTH = 10
// DataForSEO takes at most 100 tasks in one submission.
export const MAX_TASKS_PER_POST = 100

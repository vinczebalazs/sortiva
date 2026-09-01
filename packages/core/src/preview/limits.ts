/**
 * main §3.2 / §3.3 — the preview's cost controls, in one file so the numbers
 * that decide what a stranger can make us spend are readable together.
 *
 * The preview is the only unauthenticated surface in the product (tech §3), and
 * main §14.5 is explicit that its spend trip firing at all "means Turnstile,
 * rate limits, or the cache are being defeated". These are the three.
 *
 * Not in `packages/rules`: `signals.config.yaml` is the Opportunity Engine's
 * threshold layer (main §7.10) and this card may not edit that package. See
 * DECISIONS 2026-09-01 T1.3.
 */

/** main §3.2 — "hard timeout (~8s), max download size (~1.5 MB), follow at most 2 redirects". */
export const PREVIEW_FETCH_BUDGET = {
  timeoutMs: 8_000,
  maxBytes: 1_500_000,
  maxRedirects: 2,
} as const

/** main §3.2 — "per-IP (e.g. 5/min, 20/day) and a global concurrency cap on outbound scrapes". */
export const PREVIEW_RATE_LIMITS = {
  perIpPerMinute: 5,
  perIpPerDay: 20,
  globalConcurrentFetches: 4,
} as const

/** main §3.2 — "cache key = normalized domain. TTL ~7 days." */
export const PREVIEW_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * main §3.3 — "only if the above yields < ~200 chars of signal, try one more
 * fetch of a likely about page", and those are the three paths it names.
 */
export const PREVIEW_MIN_SIGNAL_CHARS = 200
export const PREVIEW_ABOUT_PATHS = ['/about', '/about-us', '/pages/about-us'] as const

/**
 * main §3.3 — "truncate to a small token budget (~2k tokens input)" and
 * "max ~150 output tokens". Characters, at the usual ~4 chars per token.
 */
export const PREVIEW_MAX_INPUT_CHARS = 8_000
export const PREVIEW_MAX_OUTPUT_TOKENS = 150

/** main §3.3 — "temperature low". Haiku accepts it; see the model registry. */
export const PREVIEW_TEMPERATURE = 0.2

/**
 * main §14.5 — "Daily preview LLM spend > its own cap → pause the preview
 * endpoint only ... serve cache hits as normal, and answer cache misses with
 * the graceful generic card". This is the `ops_flags` name that trip raises;
 * invariant 17 puts enforcement in our code against our DB, never in PostHog.
 */
export const PREVIEW_PAUSED_FLAG = 'global.pause_preview'

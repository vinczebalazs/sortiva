/**
 * The preview's cost controls, in one file so the numbers that decide what a
 * stranger can make us spend are readable together.
 *
 * The preview is the only unauthenticated surface in the product, and its spend
 * cap tripping at all means one of these three — the bot challenge, the rate
 * limits, or the cache — is being defeated.
 *
 * These deliberately do not live in `packages/rules`: that file is the
 * Opportunity Engine's threshold layer, and this card may not edit that package.
 * See DECISIONS 2026-09-01 T1.3.
 */

/** What one outbound scrape may cost us: how long it may take, how much it may download, and how far it may be redirected. */
export const PREVIEW_FETCH_BUDGET = {
  timeoutMs: 8_000,
  maxBytes: 1_500_000,
  maxRedirects: 2,
} as const

/** How often one caller may ask, and how many scrapes we will have in flight at once across everyone. */
export const PREVIEW_RATE_LIMITS = {
  perIpPerMinute: 5,
  perIpPerDay: 20,
  globalConcurrentFetches: 4,
} as const

/** How long a preview for a domain is reused. Keyed on the normalised domain, so casing and `www.` do not buy a second scrape. */
export const PREVIEW_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * If the homepage yields less than this much usable text, we try one more fetch
 * of a likely about page — one, not a crawl.
 */
export const PREVIEW_MIN_SIGNAL_CHARS = 200
export const PREVIEW_ABOUT_PATHS = ['/about', '/about-us', '/pages/about-us'] as const

/**
 * The model call's budget: roughly 2k tokens in and 150 out. Expressed in
 * characters, at the usual four-per-token. This is the single largest cost per
 * preview, so it is capped rather than left to the length of the page.
 */
export const PREVIEW_MAX_INPUT_CHARS = 8_000
export const PREVIEW_MAX_OUTPUT_TOKENS = 150

/** Low, because this is a summary of what a page says and not a place for invention. */
export const PREVIEW_TEMPERATURE = 0.2

/**
 * The flag raised when daily preview spend passes its cap. It pauses the preview
 * endpoint and nothing else: cache hits still serve as normal, and a miss gets
 * the generic card. Enforced by our own code against our own database, so it
 * works when the analytics vendor does not.
 */
export const PREVIEW_PAUSED_FLAG = 'global.pause_preview'

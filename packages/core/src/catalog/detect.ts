import type { StorePage, StorePageFetcher } from './ports'

/**
 * Is this a Shopify store? Everything downstream depends on the answer: a
 * Shopify store is asked for read permission and then read through the Admin
 * API, and anything else is parked with an explanation and never ingested.
 *
 * There are exactly two outcomes. No detection for other shop platforms is
 * built or scaffolded — a half-built third branch is worse than none.
 */

export const SHOPIFY_SIGNALS = [
  /** A response header naming Shopify, which their edge sets on every storefront. */
  'response_header',
  /** `X-ShopId`, the numeric store id Shopify puts on storefront responses. */
  'shop_id_header',
  /** Theme assets served from `cdn.shopify.com`. */
  'cdn_asset',
  /** The `window.Shopify` object every storefront theme defines. */
  'window_shopify',
  /** `/products.json` answering 200, which only a Shopify storefront does. */
  'products_json',
] as const

export type ShopifySignal = (typeof SHOPIFY_SIGNALS)[number]

export type DetectedPlatform = 'shopify' | 'custom_unsupported'

export interface PlatformDetection {
  readonly platform: DetectedPlatform
  /** Which signals fired, so a wrong answer can be explained rather than guessed at. */
  readonly signals: readonly ShopifySignal[]
  /**
   * The store's canonical `*.myshopify.com` name, without the suffix. Undefined
   * when the storefront revealed none — the OAuth handshake is addressed to
   * this name, so a Shopify store without one cannot be connected.
   */
  readonly shopHandle?: string
  /** Where the homepage actually resolved, after redirects. */
  readonly finalUrl: string
}

/** `abc-store.myshopify.com` → `abc-store`. Shopify handles are lower-case alphanumeric with hyphens. */
const MYSHOPIFY_HOST = /\b([a-z0-9][a-z0-9-]{0,59})\.myshopify\.com\b/i
/** Where `/admin` lands for a store whose owner is signed in to the new admin. */
const ADMIN_STORE_PATH = /admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]{0,59})\b/i

/**
 * The documented budget, which is the one the single outbound fetcher uses
 * everywhere: about 1.5 MB.
 *
 * It used to be 600 KB here, on the reasoning that detection only needs the head
 * and the first chunk of body. That reasoning is wrong in the one direction that
 * matters: the fetcher **refuses** a response over the budget rather than
 * truncating it, so a heavy storefront was not read partially, it was not read
 * at all — and the store dead-lettered before it had begun. Reproduced against
 * two real shops: one over the old cap failed, one under it worked.
 */
const HOMEPAGE_BUDGET = { timeoutMs: 8_000, maxBytes: 1_500_000, maxRedirects: 3 }
/** A product feed page, which is JSON rather than markup. */
const PROBE_BUDGET = { timeoutMs: 6_000, maxBytes: 200_000, maxRedirects: 2 }

export interface DetectDeps {
  readonly fetcher: StorePageFetcher
}

/**
 * Fetches the store's homepage, reads the Shopify tells out of it, and — only
 * when none of them fired — spends one more request on the `/products.json`
 * probe. The probe is last because it is the weakest evidence and the only one
 * that costs a second round trip.
 */
export async function detectPlatform(
  deps: DetectDeps,
  domain: string,
): Promise<PlatformDetection> {
  const home = await deps.fetcher.fetch({
    url: `https://${domain}/`,
    budget: HOMEPAGE_BUDGET,
  })

  const signals = signalsFrom(home)

  if (signals.length === 0) {
    const productsJson = await probeProductsJson(deps, domain)
    if (productsJson) signals.push('products_json')
  }

  if (signals.length === 0) {
    return { platform: 'custom_unsupported', signals: [], finalUrl: home.finalUrl }
  }

  const shopHandle = await resolveShopHandle(deps, domain, home)
  return {
    platform: 'shopify',
    signals,
    finalUrl: home.finalUrl,
    ...(shopHandle ? { shopHandle } : {}),
  }
}

/** The tells readable from a single homepage response. */
export function signalsFrom(page: StorePage): ShopifySignal[] {
  const found: ShopifySignal[] = []
  const headers = page.headers ?? {}

  if (headers['x-shopid'] !== undefined || headers['x-shopify-stage'] !== undefined) {
    found.push('shop_id_header')
  }
  if (
    Object.entries(headers).some(
      ([name, value]) => name !== 'x-shopid' && /shopify/i.test(value ?? ''),
    )
  ) {
    found.push('response_header')
  }
  if (page.body.includes('cdn.shopify.com')) found.push('cdn_asset')
  if (/window\.Shopify\b|\bShopify\.(shop|theme|routes)\b/.test(page.body)) {
    found.push('window_shopify')
  }
  return found
}

/**
 * A 200 with a `products` array. A custom site that happens to serve something
 * at that path is not a Shopify store, so the shape is checked and not just the
 * status.
 */
async function probeProductsJson(deps: DetectDeps, domain: string): Promise<boolean> {
  let page: StorePage
  try {
    page = await deps.fetcher.fetch({
      url: `https://${domain}/products.json?limit=1`,
      budget: PROBE_BUDGET,
      contentTypes: ['application/json'],
    })
  } catch {
    // Any refusal — 404, a redirect to a marketing page, a timeout — is simply
    // "no signal here". The homepage fetch above is what decides whether the
    // site is reachable at all, and it already succeeded.
    return false
  }
  if (page.status !== 200) return false
  try {
    const parsed: unknown = JSON.parse(page.body)
    return typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { products?: unknown }).products)
  } catch {
    return false
  }
}

/**
 * The `*.myshopify.com` name OAuth is addressed to, from whichever source
 * reveals it first:
 *
 *  1. the homepage itself, if the merchant never set a custom domain;
 *  2. anywhere in the homepage markup — themes routinely print it;
 *  3. `/admin`, which redirects to the store's admin address.
 *
 * Custom-domain stores on a locked-down theme can reveal none of these. That is
 * a store we cannot start the handshake for, and the caller treats it as a
 * failure rather than inventing a name.
 */
export async function resolveShopHandle(
  deps: DetectDeps,
  domain: string,
  home: StorePage,
): Promise<string | undefined> {
  const fromDomain = MYSHOPIFY_HOST.exec(domain)?.[1]
  if (fromDomain) return fromDomain.toLowerCase()

  const fromFinalUrl = MYSHOPIFY_HOST.exec(home.finalUrl)?.[1]
  if (fromFinalUrl) return fromFinalUrl.toLowerCase()

  const fromBody = MYSHOPIFY_HOST.exec(home.body)?.[1]
  if (fromBody) return fromBody.toLowerCase()

  try {
    const admin = await deps.fetcher.fetch({
      url: `https://${domain}/admin`,
      budget: PROBE_BUDGET,
    })
    const trail = [...admin.chain, admin.finalUrl].join(' ')
    const fromAdmin = ADMIN_STORE_PATH.exec(trail)?.[1] ?? MYSHOPIFY_HOST.exec(trail)?.[1]
    if (fromAdmin) return fromAdmin.toLowerCase()
  } catch {
    // `/admin` refusing us is normal — it is behind a login.
  }
  return undefined
}

/** A syntactically valid store name, checked before it is ever put in a URL. */
export function isShopHandle(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,59}$/.test(value)
}

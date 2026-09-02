import { SHOPIFY_API_VERSION } from './oauth'
import { ShopifyRateLimiters, type ShopifyRateLimiterOptions } from './limiter'

/**
 * The one Admin API client. Every read of a merchant's store goes through it,
 * so the four behaviours that matter are inherited rather than re-implemented:
 *
 *  - a rejected token is its own kind of failure, not a retryable error. The
 *    merchant has to reconnect, and no amount of retrying gets us there.
 *  - a 429 carries `Retry-After`, and Shopify means it exactly.
 *  - background reads are paced at one request a second per store, so a walk of
 *    a large catalogue never crowds out a merchant's own admin.
 *  - long lists are handed back a page at a time, with the address of the next
 *    page taken from Shopify's own `Link` header rather than guessed at.
 */

export class ShopifyTokenInvalid extends Error {
  override readonly name = 'ShopifyTokenInvalid'
  /** Retrying cannot fix a dead token; only the merchant can. */
  readonly retryable = false
  readonly errorClass = 'shopify_token_invalid'

  constructor(readonly shop: string, status: number) {
    super(`Shopify rejected our token for ${shop} (${status}).`)
  }
}

export class ShopifyApiFailure extends Error {
  override readonly name = 'ShopifyApiFailure'
  readonly retryable: boolean
  readonly errorClass: string

  constructor(
    message: string,
    options: { retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, options as ErrorOptions)
    this.retryable = options.retryable ?? true
    this.errorClass = options.retryAfterMs === undefined ? 'shopify_api_error' : 'shopify_rate_limited'
    this.retryAfterMs = options.retryAfterMs
  }

  readonly retryAfterMs: number | undefined
}

/** The handful of shop fields the connection screen and the persona defaults need. */
export interface ShopProfile {
  readonly id: number
  readonly name: string
  readonly myshopifyDomain: string
  readonly primaryDomain: string | null
  readonly countryCode: string | null
  readonly currency: string | null
  readonly ianaTimezone: string | null
}

export interface ShopifyAdminClientOptions {
  fetchImpl?: typeof fetch
  storeBaseUrl?: (shop: string) => string
  /** Overrides the pacing. Tests only; production takes the background budget. */
  limiter?: ShopifyRateLimiterOptions
}

/** One page of a Shopify list, plus where the next one starts. */
export interface ShopifyPage<T> {
  readonly body: T
  /**
   * Shopify's cursor for the following page, or undefined at the end of the
   * list. Opaque: it is theirs, and reading anything into it is how a walk
   * silently skips records.
   */
  readonly nextPageInfo: string | undefined
}

export class ShopifyAdminClient {
  private readonly fetchImpl: typeof fetch
  private readonly storeBaseUrl: (shop: string) => string
  private readonly limiters: ShopifyRateLimiters

  constructor(options: ShopifyAdminClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.storeBaseUrl = options.storeBaseUrl ?? ((shop) => `https://${shop}.myshopify.com`)
    this.limiters = new ShopifyRateLimiters(options.limiter ?? {})
  }

  /**
   * Reads the store's own record. Called right after a token is granted, which
   * turns "Shopify handed us a string" into "we have confirmed this token can
   * read this store" before the merchant is told they are connected.
   */
  async getShop(input: { shop: string; accessToken: string }): Promise<ShopProfile> {
    const body = await this.get<{ shop?: Record<string, unknown> }>(input, 'shop.json')
    const shop = body.shop ?? {}
    return {
      id: Number(shop['id'] ?? 0),
      name: String(shop['name'] ?? ''),
      myshopifyDomain: String(shop['myshopify_domain'] ?? `${input.shop}.myshopify.com`),
      primaryDomain: asStringOrNull(shop['domain']),
      countryCode: asStringOrNull(shop['country_code']),
      currency: asStringOrNull(shop['currency']),
      ianaTimezone: asStringOrNull(shop['iana_timezone']),
    }
  }

  async get<T>(input: { shop: string; accessToken: string }, path: string): Promise<T> {
    return (await this.getPage<T>(input, path)).body
  }

  /**
   * The same read, keeping the page cursor Shopify puts in the `Link` header.
   *
   * Every list read goes through here. The catalogue walk needs the cursor so a
   * crash resumes at the page it reached rather than at the first one.
   */
  async getPage<T>(
    input: { shop: string; accessToken: string },
    path: string,
  ): Promise<ShopifyPage<T>> {
    // Pacing happens before the request leaves, and a caller cannot opt out:
    // this is the only place a Shopify read is made, so the store's budget is
    // spent here or nowhere.
    await this.limiters.for(input.shop).acquire()

    const url = `${this.storeBaseUrl(input.shop)}/admin/api/${SHOPIFY_API_VERSION}/${path}`
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        headers: {
          'X-Shopify-Access-Token': input.accessToken,
          accept: 'application/json',
        },
      })
    } catch (cause) {
      throw new ShopifyApiFailure(`Could not reach Shopify for ${path}.`, { cause })
    }

    if (response.status === 401 || response.status === 403) {
      throw new ShopifyTokenInvalid(input.shop, response.status)
    }
    if (response.status === 429) {
      const retryAfterMs = retryAfterFrom(response.headers.get('retry-after'))
      // Hold the whole store back, not just this call: the bucket that emptied
      // is the store's, so the next request from any caller would be refused
      // too. Honoured exactly — Shopify's number, not a guess of ours.
      this.limiters.for(input.shop).pauseFor(retryAfterMs)
      throw new ShopifyApiFailure(`Shopify rate-limited ${path}.`, { retryAfterMs })
    }
    if (!response.ok) {
      throw new ShopifyApiFailure(`Shopify answered ${response.status} for ${path}.`, {
        // A 4xx that is not a dead token or a rate limit is a request we got
        // wrong; sending it again would only get it wrong again.
        retryable: response.status >= 500,
      })
    }
    return {
      body: (await response.json()) as T,
      nextPageInfo: nextPageInfoFrom(response.headers.get('link')),
    }
  }
}

/**
 * The address of the next page, out of Shopify's `Link` header:
 * `<https://…/products.json?limit=250&page_info=abc>; rel="next"`.
 *
 * Only `page_info` is kept. Following the whole URL would carry Shopify's own
 * host and query into a request we otherwise build ourselves, and a header is
 * not a place to take a URL from unchecked.
 */
export function nextPageInfoFrom(header: string | null): string | undefined {
  if (!header) return undefined
  for (const part of header.split(',')) {
    if (!/rel\s*=\s*"?next"?/i.test(part)) continue
    const url = part.match(/<([^>]+)>/)?.[1]
    if (!url) continue
    const pageInfo = new URL(url).searchParams.get('page_info')
    if (pageInfo) return pageInfo
  }
  return undefined
}

/** Shopify sends seconds. Honoured exactly rather than rounded up to a default. */
export function retryAfterFrom(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return Math.ceil(seconds * 1000)
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

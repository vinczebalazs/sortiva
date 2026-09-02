import { SHOPIFY_API_VERSION } from './oauth'

/**
 * The smallest possible Admin API client: enough to confirm a freshly granted
 * token actually works, and to give every later Shopify read one place to
 * inherit the two behaviours that matter.
 *
 * Those two are the reason this exists now rather than with the catalogue sync:
 *
 *  - a rejected token is its own kind of failure, not a retryable error. The
 *    merchant has to reconnect, and no amount of retrying gets us there.
 *  - a 429 carries `Retry-After`, and Shopify means it exactly.
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
}

export class ShopifyAdminClient {
  private readonly fetchImpl: typeof fetch
  private readonly storeBaseUrl: (shop: string) => string

  constructor(options: ShopifyAdminClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.storeBaseUrl = options.storeBaseUrl ?? ((shop) => `https://${shop}.myshopify.com`)
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
      throw new ShopifyApiFailure(`Shopify rate-limited ${path}.`, { retryAfterMs })
    }
    if (!response.ok) {
      throw new ShopifyApiFailure(`Shopify answered ${response.status} for ${path}.`, {
        // A 4xx that is not a dead token or a rate limit is a request we got
        // wrong; sending it again would only get it wrong again.
        retryable: response.status >= 500,
      })
    }
    return (await response.json()) as T
  }
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

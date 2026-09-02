import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  isShopHandle,
  SHOPIFY_READ_SCOPE_PARAM,
  type ShopifyAccessGrant,
  type ShopifyCallbackParams,
  type ShopifyOAuthProvider,
} from '@sortiva/core'

/**
 * The install handshake with Shopify, and the only code in the repository that
 * talks to them about permission.
 *
 * Three jobs: build the address the merchant's browser is sent to, prove that
 * the redirect back really came from Shopify, and trade the one-time code for a
 * lasting token. Everything else about the connection — which permissions we
 * ask for, what happens when a token dies — is policy and lives in
 * `packages/core/catalog`.
 */

/** The Admin API version we pin. Shopify retires versions on a published schedule. */
export const SHOPIFY_API_VERSION = '2025-01'

export class ShopifyOAuthFailure extends Error {
  override readonly name = 'ShopifyOAuthFailure'
  /** A network hiccup during the exchange is worth another attempt; a rejection is not. */
  readonly retryable: boolean
  readonly errorClass: string

  constructor(message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, options as ErrorOptions)
    this.retryable = options.retryable ?? false
    this.errorClass = this.retryable ? 'shopify_oauth_unavailable' : 'shopify_oauth_rejected'
  }
}

export interface ShopifyOAuthClientOptions {
  apiKey?: string
  apiSecret?: string
  /** Injected by tests so the exchange can be driven against a local server. */
  fetchImpl?: typeof fetch
  /** Overrides the `https://<shop>.myshopify.com` base. Tests only. */
  storeBaseUrl?: (shop: string) => string
}

export class ShopifyOAuthClient implements ShopifyOAuthProvider {
  private readonly apiKey: string
  private readonly apiSecret: string
  private readonly fetchImpl: typeof fetch
  private readonly storeBaseUrl: (shop: string) => string

  constructor(options: ShopifyOAuthClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.SHOPIFY_API_KEY
    const apiSecret = options.apiSecret ?? process.env.SHOPIFY_API_SECRET
    if (!apiKey || !apiSecret) {
      throw new Error(
        'SHOPIFY_API_KEY and SHOPIFY_API_SECRET are not set. Use MockShopifyOAuthClient outside production.',
      )
    }
    this.apiKey = apiKey
    this.apiSecret = apiSecret
    this.fetchImpl = options.fetchImpl ?? fetch
    this.storeBaseUrl = options.storeBaseUrl ?? ((shop) => `https://${shop}.myshopify.com`)
  }

  /**
   * The consent screen the merchant lands on. The scope list is taken from
   * `packages/core` rather than written here, so there is one answer to "what
   * are we asking for" and the test that proves it holds no write permission
   * covers this URL too.
   *
   * No `grant_options[]=per-user`: the token has to keep working after the
   * person who installed us closes their laptop, because the work happens on a
   * schedule.
   */
  authorizeUrl(input: { shop: string; redirectUri: string; state: string }): string {
    assertShop(input.shop)
    const url = new URL(`${this.storeBaseUrl(input.shop)}/admin/oauth/authorize`)
    url.searchParams.set('client_id', this.apiKey)
    url.searchParams.set('scope', SHOPIFY_READ_SCOPE_PARAM)
    url.searchParams.set('redirect_uri', input.redirectUri)
    url.searchParams.set('state', input.state)
    return url.toString()
  }

  /**
   * Shopify signs the redirect's query string. Without this check anyone could
   * hand us a URL naming a store and a code of their choosing — which is how
   * someone else's store, or someone else's token, would end up attached to an
   * account.
   */
  verifyCallbackSignature(params: ShopifyCallbackParams): boolean {
    return verifyCallbackHmac(params.query, this.apiSecret)
  }

  async exchangeCode(input: { shop: string; code: string }): Promise<ShopifyAccessGrant> {
    assertShop(input.shop)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.storeBaseUrl(input.shop)}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_id: this.apiKey,
          client_secret: this.apiSecret,
          code: input.code,
        }),
      })
    } catch (cause) {
      throw new ShopifyOAuthFailure('Could not reach Shopify to exchange the code.', {
        retryable: true,
        cause,
      })
    }

    if (!response.ok) {
      // A used or expired code is a dead end: the merchant has to start again.
      // Only a Shopify-side fault is worth retrying.
      throw new ShopifyOAuthFailure(`Shopify refused the code exchange (${response.status}).`, {
        retryable: response.status >= 500,
      })
    }

    const payload = (await response.json().catch(() => undefined)) as
      | { access_token?: unknown; scope?: unknown }
      | undefined
    const accessToken = typeof payload?.access_token === 'string' ? payload.access_token : undefined
    if (!accessToken) {
      throw new ShopifyOAuthFailure('Shopify answered the code exchange without a token.')
    }
    const scope = typeof payload?.scope === 'string' ? payload.scope : ''
    return {
      accessToken,
      grantedScopes: scope
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    }
  }
}

/**
 * The signature Shopify puts on the redirect: every other query parameter,
 * sorted by name and joined, signed with the app's secret.
 *
 * Compared in constant time. A comparison that returns early on the first
 * differing byte leaks how much of a guess was right, which is enough to
 * reconstruct a signature one byte at a time.
 */
export function verifyCallbackHmac(
  query: Readonly<Record<string, string>>,
  apiSecret: string,
): boolean {
  const provided = query['hmac']
  if (!provided) return false

  const message = Object.keys(query)
    .filter((key) => key !== 'hmac' && key !== 'signature')
    .sort()
    .map((key) => `${key}=${query[key]}`)
    .join('&')

  const expected = createHmac('sha256', apiSecret).update(message, 'utf8').digest('hex')
  return safeEqualHex(provided, expected)
}

/**
 * The signature on a webhook body, which Shopify sends base64-encoded in
 * `X-Shopify-Hmac-Sha256`. Verified against the **raw** bytes: re-serialising
 * parsed JSON changes whitespace and key order, and the signature is over what
 * was sent, not over what it means.
 */
export function verifyWebhookHmac(rawBody: Buffer | string, header: string, secret: string): boolean {
  if (!header) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest('base64')
  const a = Buffer.from(header, 'base64')
  const b = Buffer.from(expected, 'base64')
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}

function safeEqualHex(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** `shop` reaches us from a URL a stranger can write, and is about to become one. */
export function assertShop(shop: string): void {
  if (!isShopHandle(shop)) {
    throw new ShopifyOAuthFailure(`"${shop}" is not a valid Shopify store name.`)
  }
}

/** `acme.myshopify.com` → `acme`; anything else is returned unchanged. */
export function shopHandleFrom(value: string): string {
  return value.toLowerCase().replace(/\.myshopify\.com$/, '')
}

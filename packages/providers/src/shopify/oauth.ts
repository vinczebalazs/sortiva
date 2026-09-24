import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  isShopHandle,
  SHOPIFY_READ_SCOPE_PARAM,
  ShopifyGrantGone,
  type ShopifyAccessGrant,
  type ShopifyCallbackParams,
  type ShopifyOAuthProvider,
} from '@sortiva/core'

/**
 * The install handshake with Shopify, and the only code in the repository that
 * talks to them about permission.
 *
 * Four jobs: build the address the merchant's browser is sent to, prove that
 * the redirect back really came from Shopify, trade the one-time code for a
 * token, and trade the refresh token for the next one. Everything else about
 * the connection — which permissions we ask for, what happens when a token
 * dies — is policy and lives in `packages/core/catalog`.
 */

/**
 * The Admin API version every call is made against.
 *
 * Shopify serves each version for a year and then quietly answers requests for
 * it with the oldest version it still supports, so a pin that is never moved
 * does not break — it drifts, and the behaviour we tested stops being the
 * behaviour we get. Move it deliberately, with the tests, at least yearly.
 */
export const SHOPIFY_API_VERSION = '2026-07'

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
  clientId?: string
  clientSecret?: string
  /** Injected by tests so the exchange can be driven against a local server. */
  fetchImpl?: typeof fetch
  /** Overrides the `https://<shop>.myshopify.com` base. Tests only. */
  storeBaseUrl?: (shop: string) => string
  /** Tests only: the clock expiry times are counted from. */
  now?: () => Date
}

interface TokenResponse {
  access_token?: unknown
  scope?: unknown
  expires_in?: unknown
  refresh_token?: unknown
  refresh_token_expires_in?: unknown
}

export class ShopifyOAuthClient implements ShopifyOAuthProvider {
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly fetchImpl: typeof fetch
  private readonly storeBaseUrl: (shop: string) => string
  private readonly now: () => Date

  constructor(options: ShopifyOAuthClientOptions = {}) {
    const clientId = options.clientId ?? process.env.SHOPIFY_CLIENT_ID
    const clientSecret = options.clientSecret ?? process.env.SHOPIFY_CLIENT_SECRET
    if (!clientId || !clientSecret) {
      throw new Error(
        'SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET are not set. Use MockShopifyOAuthClient outside production.',
      )
    }
    this.clientId = clientId
    this.clientSecret = clientSecret
    this.fetchImpl = options.fetchImpl ?? fetch
    this.storeBaseUrl = options.storeBaseUrl ?? ((shop) => `https://${shop}.myshopify.com`)
    this.now = options.now ?? (() => new Date())
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
    url.searchParams.set('client_id', this.clientId)
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
    return verifyCallbackHmac(params.query, this.clientSecret)
  }

  /**
   * Hands the grant back, which is the API equivalent of the merchant
   * uninstalling the app themselves — the store stops sending us webhooks and
   * the token stops working.
   *
   * A 401 means Shopify has already forgotten the token, which is the outcome
   * asked for rather than a failure; treating it as success is what lets the
   * deletion job be retried after a half-finished attempt.
   */
  async revokeAccess(input: { shop: string; accessToken: string }): Promise<void> {
    assertShop(input.shop)
    let response: Response
    try {
      response = await this.fetchImpl(
        `${this.storeBaseUrl(input.shop)}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          method: 'POST',
          headers: {
            'x-shopify-access-token': input.accessToken,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({ query: 'mutation { appUninstall { userErrors { message } } }' }),
        },
      )
    } catch (cause) {
      throw new ShopifyOAuthFailure('Could not reach Shopify to hand the grant back.', {
        retryable: true,
        cause,
      })
    }
    if (response.status === 401 || response.status === 404) return
    if (!response.ok) {
      throw new ShopifyOAuthFailure(`Shopify refused to revoke the grant (${response.status}).`, {
        retryable: response.status >= 500 || response.status === 429,
      })
    }
    const body = (await response.json().catch(() => undefined)) as
      | { errors?: { message?: string }[]; data?: { appUninstall?: { userErrors?: { message?: string }[] } } }
      | undefined
    const problems = [
      ...(body?.errors ?? []),
      ...(body?.data?.appUninstall?.userErrors ?? []),
    ].map((problem) => problem.message ?? 'unknown')
    if (problems.length > 0) {
      throw new ShopifyOAuthFailure(`Shopify refused to revoke the grant: ${problems.join('; ')}`)
    }
  }

  /**
   * The one-time code for the store's first token.
   *
   * `expiring: '1'` asks for the kind of token Shopify now requires of apps
   * created after April 2026: an hour-long access token plus a refresh token.
   * Without it the exchange hands back a token that never expires, which the
   * API refuses for apps like ours.
   */
  async exchangeCode(input: { shop: string; code: string }): Promise<ShopifyAccessGrant> {
    assertShop(input.shop)
    return this.tokenRequest(input.shop, {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code: input.code,
      expiring: '1',
    }, 'exchange the code')
  }

  /**
   * The next access token, bought with the stored refresh token.
   *
   * Shopify answers with a new refresh token too and retires the old one the
   * first time the new one is used — which is why the caller serialises
   * renewals per store and stores the answer before using it.
   */
  async refreshAccess(input: { shop: string; refreshToken: string }): Promise<ShopifyAccessGrant> {
    assertShop(input.shop)
    try {
      return await this.tokenRequest(input.shop, {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
      }, 'renew the token')
    } catch (error) {
      // A refused refresh token will never become valid again: the merchant
      // uninstalled us, or it expired unused for ninety days.
      if (error instanceof ShopifyOAuthFailure && !error.retryable) {
        throw new ShopifyGrantGone(input.shop, error.message)
      }
      throw error
    }
  }

  private async tokenRequest(
    shop: string,
    body: Record<string, string>,
    purpose: string,
  ): Promise<ShopifyAccessGrant> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.storeBaseUrl(shop)}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (cause) {
      throw new ShopifyOAuthFailure(`Could not reach Shopify to ${purpose}.`, {
        retryable: true,
        cause,
      })
    }

    if (!response.ok) {
      // A used or expired code, or a retired refresh token, is a dead end: the
      // merchant has to start again. Only a Shopify-side fault is worth retrying.
      throw new ShopifyOAuthFailure(`Shopify refused to ${purpose} (${response.status}).`, {
        retryable: response.status >= 500 || response.status === 429,
      })
    }

    const payload = (await response.json().catch(() => undefined)) as TokenResponse | undefined
    return grantFrom(payload, this.now(), purpose)
  }
}

/** Shopify's token answer, as the grant we keep. */
export function grantFrom(
  payload: TokenResponse | undefined,
  now: Date,
  purpose = 'issue a token',
): ShopifyAccessGrant {
  const accessToken = typeof payload?.access_token === 'string' ? payload.access_token : undefined
  if (!accessToken) {
    throw new ShopifyOAuthFailure(`Shopify answered the request to ${purpose} without a token.`)
  }
  const scope = typeof payload?.scope === 'string' ? payload.scope : ''
  const refreshToken =
    typeof payload?.refresh_token === 'string' && payload.refresh_token.length > 0
      ? payload.refresh_token
      : null
  return {
    accessToken,
    grantedScopes: scope
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    expiresAt: secondsFrom(now, payload?.expires_in),
    refreshToken,
    refreshTokenExpiresAt: refreshToken ? secondsFrom(now, payload?.refresh_token_expires_in) : null,
  }
}

function secondsFrom(now: Date, seconds: unknown): Date | null {
  const value = typeof seconds === 'string' ? Number(seconds) : seconds
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return new Date(now.getTime() + value * 1000)
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
  clientSecret: string,
): boolean {
  const provided = query['hmac']
  if (!provided) return false

  const message = Object.keys(query)
    .filter((key) => key !== 'hmac' && key !== 'signature')
    .sort()
    .map((key) => `${key}=${query[key]}`)
    .join('&')

  const expected = createHmac('sha256', clientSecret).update(message, 'utf8').digest('hex')
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

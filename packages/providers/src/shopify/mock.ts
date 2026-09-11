import { createHmac } from 'node:crypto'
import {
  SHOPIFY_READ_SCOPES,
  ShopifyGrantGone,
  type ShopifyAccessGrant,
  type ShopifyAuth,
  type ShopifyCallbackParams,
  type ShopifyOAuthProvider,
} from '@sortiva/core'
import { assertShop, verifyCallbackHmac } from './oauth'
import type { ShopProfile } from './admin'
import { ShopifyTokenInvalid } from './graphql'

/**
 * The in-memory Shopify used by every test and by local development, where
 * there is no Partner account and no dev store.
 *
 * It signs its callbacks with a secret the way Shopify does, so a test that
 * forgets to check the signature fails here rather than in production.
 */
export class MockShopifyOAuthClient implements ShopifyOAuthProvider {
  readonly exchanges: { shop: string; code: string }[] = []
  readonly refreshes: { shop: string; refreshToken: string }[] = []
  readonly revocations: { shop: string; accessToken: string }[] = []
  private grant: ShopifyAccessGrant = {
    accessToken: 'shpat_mock_token',
    grantedScopes: [...SHOPIFY_READ_SCOPES],
    expiresAt: null,
    refreshToken: null,
    refreshTokenExpiresAt: null,
  }
  private failure: Error | undefined
  private refreshFailure: Error | undefined

  constructor(private readonly clientSecret = 'mock-shopify-secret') {}

  /** Sets what the next exchange returns — a narrower grant, a write scope, anything. */
  grants(grant: Partial<ShopifyAccessGrant>): this {
    this.grant = { ...this.grant, ...grant }
    return this
  }

  failsWith(error: Error): this {
    this.failure = error
    return this
  }

  /** Makes the next renewal fail the way a retired refresh token does. */
  refusesRefresh(error: Error = new ShopifyGrantGone('mock-store', 'the refresh token was refused')): this {
    this.refreshFailure = error
    return this
  }

  authorizeUrl(input: { shop: string; redirectUri: string; state: string }): string {
    assertShop(input.shop)
    const url = new URL(`https://${input.shop}.myshopify.com/admin/oauth/authorize`)
    url.searchParams.set('client_id', 'mock-key')
    url.searchParams.set('scope', SHOPIFY_READ_SCOPES.join(','))
    url.searchParams.set('redirect_uri', input.redirectUri)
    url.searchParams.set('state', input.state)
    return url.toString()
  }

  verifyCallbackSignature(params: ShopifyCallbackParams): boolean {
    return verifyCallbackHmac(params.query, this.clientSecret)
  }

  /** Records the hand-back; a grant already gone is not an error. */
  async revokeAccess(input: { shop: string; accessToken: string }): Promise<void> {
    assertShop(input.shop)
    this.revocations.push(input)
  }

  async exchangeCode(input: { shop: string; code: string }): Promise<ShopifyAccessGrant> {
    assertShop(input.shop)
    this.exchanges.push(input)
    if (this.failure) throw this.failure
    return this.grant
  }

  /** Answers with a token whose name says which renewal produced it, as Shopify's rotation does. */
  async refreshAccess(input: { shop: string; refreshToken: string }): Promise<ShopifyAccessGrant> {
    assertShop(input.shop)
    this.refreshes.push(input)
    if (this.refreshFailure) throw this.refreshFailure
    const round = this.refreshes.length
    return {
      ...this.grant,
      accessToken: `${this.grant.accessToken}_renewed_${round}`,
      refreshToken: `${this.grant.refreshToken ?? 'shprt_mock'}_${round}`,
      expiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 7_776_000_000),
    }
  }

  /** Signs a query the way Shopify does, so a test can build a genuine callback. */
  signCallback(query: Readonly<Record<string, string>>): Record<string, string> {
    const message = Object.keys(query)
      .filter((key) => key !== 'hmac' && key !== 'signature')
      .sort()
      .map((key) => `${key}=${query[key]}`)
      .join('&')
    return {
      ...query,
      hmac: createHmac('sha256', this.clientSecret).update(message, 'utf8').digest('hex'),
    }
  }
}

/** Answers shop reads from memory, and can be told to start rejecting our token. */
export class MockShopifyAdminClient {
  private profile: ShopProfile = {
    id: '1',
    name: 'Mock Store',
    myshopifyDomain: 'mock-store.myshopify.com',
    primaryDomain: 'mock-store.example',
    countryCode: 'GB',
    currency: 'GBP',
    ianaTimezone: 'Europe/London',
    primaryLocale: 'en-GB',
  }
  private rejecting = false
  readonly calls: string[] = []

  describes(profile: Partial<ShopProfile>): this {
    this.profile = { ...this.profile, ...profile }
    return this
  }

  /** From here on every call answers the way Shopify does once a token is dead. */
  rejectsToken(): this {
    this.rejecting = true
    return this
  }

  async getShop(auth: ShopifyAuth): Promise<ShopProfile> {
    this.calls.push(`shop:${auth.shop}`)
    if (this.rejecting) throw new ShopifyTokenInvalid(auth.shop, 401)
    return this.profile
  }
}

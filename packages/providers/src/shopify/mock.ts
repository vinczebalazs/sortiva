import { createHmac } from 'node:crypto'
import {
  SHOPIFY_READ_SCOPES,
  type ShopifyAccessGrant,
  type ShopifyCallbackParams,
  type ShopifyOAuthProvider,
} from '@sortiva/core'
import { assertShop, verifyCallbackHmac } from './oauth'
import type { ShopProfile } from './admin'
import { ShopifyTokenInvalid } from './admin'

/**
 * The in-memory Shopify used by every test and by local development, where
 * there is no Partner account and no dev store.
 *
 * It signs its callbacks with a secret the way Shopify does, so a test that
 * forgets to check the signature fails here rather than in production.
 */
export class MockShopifyOAuthClient implements ShopifyOAuthProvider {
  readonly exchanges: { shop: string; code: string }[] = []
  private grant: ShopifyAccessGrant = {
    accessToken: 'shpat_mock_token',
    grantedScopes: [...SHOPIFY_READ_SCOPES],
  }
  private failure: Error | undefined

  constructor(private readonly apiSecret = 'mock-shopify-secret') {}

  /** Sets what the next exchange returns — a narrower grant, a write scope, anything. */
  grants(grant: Partial<ShopifyAccessGrant>): this {
    this.grant = { ...this.grant, ...grant }
    return this
  }

  failsWith(error: Error): this {
    this.failure = error
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
    return verifyCallbackHmac(params.query, this.apiSecret)
  }

  async exchangeCode(input: { shop: string; code: string }): Promise<ShopifyAccessGrant> {
    assertShop(input.shop)
    this.exchanges.push(input)
    if (this.failure) throw this.failure
    return this.grant
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
      hmac: createHmac('sha256', this.apiSecret).update(message, 'utf8').digest('hex'),
    }
  }
}

/** Answers shop reads from memory, and can be told to start rejecting our token. */
export class MockShopifyAdminClient {
  private profile: ShopProfile = {
    id: 1,
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

  async getShop(input: { shop: string; accessToken: string }): Promise<ShopProfile> {
    this.calls.push(`shop.json:${input.shop}`)
    if (this.rejecting) throw new ShopifyTokenInvalid(input.shop, 401)
    return this.profile
  }
}

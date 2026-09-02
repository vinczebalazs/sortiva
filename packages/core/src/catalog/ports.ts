/**
 * `packages/core` holds domain logic and no I/O, so connecting a store talks to
 * ports. `apps/web` and the ingestion jobs bind them to the guarded HTTP
 * client, the Shopify adapter and Postgres.
 */

/** One guarded fetch, as store detection sees it. Structurally `PageFetchResult` in `@sortiva/providers`. */
export interface StorePage {
  readonly finalUrl: string
  readonly status: number
  readonly contentType: string
  readonly body: string
  readonly bytes: number
  /** Every URL in the redirect chain, the requested one first. */
  readonly chain: readonly string[]
  /** Response headers of the final hop, lower-cased names. */
  readonly headers: Readonly<Record<string, string>>
}

/**
 * The one guarded HTTP client, as detection sees it. There is exactly one fetch
 * implementation in the product and this is a view of it, not a second path:
 * anything that reaches out to a stranger's server has to go through the same
 * anti-SSRF guard.
 */
export interface StorePageFetcher {
  fetch(request: {
    url: string
    budget?: { timeoutMs?: number; maxBytes?: number; maxRedirects?: number }
    /** MIME types this caller can read beyond the default page types. */
    contentTypes?: readonly string[]
  }): Promise<StorePage>
}

/** What Shopify hands back when we trade the authorization code for a token. */
export interface ShopifyAccessGrant {
  readonly accessToken: string
  /** Exactly what Shopify granted, which is not necessarily what we asked for. */
  readonly grantedScopes: readonly string[]
}

export interface ShopifyCallbackParams {
  /** Every query parameter Shopify put on the redirect, `hmac` included. */
  readonly query: Readonly<Record<string, string>>
}

/**
 * The Shopify side of the install handshake. The implementation lives in
 * `packages/providers/shopify` and is the only code allowed to talk to Shopify.
 */
export interface ShopifyOAuthProvider {
  /** Where to send the merchant's browser. Read scopes only; see `SHOPIFY_READ_SCOPES`. */
  authorizeUrl(input: { shop: string; redirectUri: string; state: string }): string
  /**
   * Confirms the redirect really came from Shopify by checking the signature it
   * put on the query string. A forged callback is how someone would otherwise
   * bind their own store — or their own token — to somebody else's account.
   */
  verifyCallbackSignature(params: ShopifyCallbackParams): boolean
  exchangeCode(input: { shop: string; code: string }): Promise<ShopifyAccessGrant>
}

/** One store's connection as stored, with the token still encrypted. */
export interface StoreConnection {
  readonly accountId: string
  readonly shopHandle: string
  readonly grantedScopes: readonly string[]
  readonly connectedAt: Date
  /** When Shopify last rejected our token; null while the connection is good. */
  readonly invalidatedAt: Date | null
}

/** Persistence for the connection and for the domain state it drives. */
export interface StoreConnectionStore {
  read(accountId: string): Promise<StoreConnection | undefined>
  /** Writes the connection, encrypting the token on the way in. */
  save(input: {
    accountId: string
    shopHandle: string
    accessToken: string
    grantedScopes: readonly string[]
  }): Promise<StoreConnection>
  /** Reads the token back, decrypted, for a caller about to make an API call. */
  readToken(accountId: string): Promise<string | undefined>
  /** Records that Shopify rejected the token, so the merchant is asked to reconnect. */
  markInvalid(accountId: string, at: Date): Promise<void>
}

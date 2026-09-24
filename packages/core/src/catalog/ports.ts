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

/** What Shopify hands back when we trade the authorization code — or a refresh token — for a token. */
export interface ShopifyAccessGrant {
  readonly accessToken: string
  /** Exactly what Shopify granted, which is not necessarily what we asked for. */
  readonly grantedScopes: readonly string[]
  /**
   * When the access token stops working. Shopify requires apps like ours to
   * hold tokens that last an hour, so null only ever describes a token issued
   * before that rule — or a test double.
   */
  readonly expiresAt: Date | null
  /**
   * What buys the next access token without asking the merchant again. Every
   * renewal hands back a new one and retires the previous one on first use,
   * which is why it is stored the moment it arrives.
   */
  readonly refreshToken: string | null
  readonly refreshTokenExpiresAt: Date | null
}

/**
 * How a call reaches one store: its handle, and a way to get a token that works.
 *
 * A token is asked for per request rather than handed over once, because a
 * catalogue walk can outlast the hour a token lives. Whoever builds this owns
 * renewing it; a caller only ever asks.
 */
export interface ShopifyAuth {
  readonly shop: string
  /** A token good for the next request, renewed ahead of expiry when it is close. */
  accessToken(): Promise<string>
  /**
   * Shopify has just refused `rejected`. Answers with a token worth one more
   * try — renewed now, or already replaced by another worker or a reconnect —
   * or undefined when there is nothing left to try and the merchant has to
   * reconnect.
   */
  refreshed(rejected: string): Promise<string | undefined>
}

/** An auth that never renews: for tests, and for the one call made with a token we have just been handed. */
export function staticShopifyAuth(shop: string, token: string): ShopifyAuth {
  return {
    shop,
    accessToken: async () => token,
    refreshed: async () => undefined,
  }
}

/**
 * The store's grant has ended — Shopify refused the token and there is no way
 * to renew it. Carries the same failure class a refused request does, so the job
 * runtime routes both to the reconnect screen rather than to a retry.
 */
export class ShopifyGrantGone extends Error {
  override readonly name = 'ShopifyGrantGone'
  readonly retryable = false
  readonly errorClass = 'shopify_token_invalid'
  constructor(readonly shop: string, reason: string) {
    super(`Shopify will not give us a token for ${shop}: ${reason}`)
  }
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
  /**
   * Trades the stored refresh token for a new access token and a new refresh
   * token. Throws `ShopifyGrantGone` when Shopify refuses the refresh token —
   * the merchant has to reconnect — and a retryable failure when Shopify could
   * not be reached, in which case the old refresh token still works.
   */
  refreshAccess(input: { shop: string; refreshToken: string }): Promise<ShopifyAccessGrant>
  /**
   * Hands the grant back — the API call that is the programmatic equivalent of
   * the merchant uninstalling the app themselves.
   *
   * Used when an account is deleted. Shopify treats a token it has already
   * forgotten as gone rather than as an error, so calling this twice is a
   * no-op, which is what lets the deletion job be retried.
   */
  revokeAccess(input: { shop: string; accessToken: string }): Promise<void>
}

/** The part of the OAuth provider that renews tokens, which is all a token store needs of it. */
export type ShopifyTokenRenewer = Pick<ShopifyOAuthProvider, 'refreshAccess'>

/** One store's connection as stored, with the token still encrypted. */
export interface StoreConnection {
  readonly accountId: string
  readonly shopHandle: string
  readonly grantedScopes: readonly string[]
  readonly connectedAt: Date
  /** When Shopify last rejected our token; null while the connection is good. */
  readonly invalidatedAt: Date | null
  /**
   * When this account first allowed us to publish, if it ever did. Survives a
   * lost connection, because it is a statement about what the merchant agreed
   * to rather than about the token we currently hold.
   */
  readonly publishGrantedAt?: Date | null
  /** The host the storefront serves on, as the store itself reports it. */
  readonly storefrontHost?: string | null
}

/** Persistence for the connection and for the domain state it drives. */
export interface StoreConnectionStore {
  read(accountId: string): Promise<StoreConnection | undefined>
  /** Writes the connection, encrypting both tokens on the way in. */
  save(input: { accountId: string; shopHandle: string } & ShopifyAccessGrant): Promise<StoreConnection>
  /** Reads the token back, decrypted, for a caller about to make an API call. */
  readToken(accountId: string): Promise<string | undefined>
  /** Records that Shopify rejected the token, so the merchant is asked to reconnect. */
  markInvalid(accountId: string, at: Date): Promise<void>
}

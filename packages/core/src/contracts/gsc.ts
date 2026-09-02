/**
 * Google Search Console behind an interface of our own, so the sync jobs can be
 * tested without a Google account and so exactly one module ever holds a
 * merchant's Google credentials.
 *
 * Unlike the SEO vendor, Search Console costs nothing per call and has no spend
 * ledger — its limit is a request quota, not a bill. What it does have is a
 * merchant's OAuth grant, which is why the shape below keeps tokens in one type
 * that is only ever handed to this provider and to the encryptor.
 */

/** Read-only access to a merchant's Search Console data. Nothing here can write to their property. */
export const GSC_READONLY_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly'

export interface GscTokens {
  readonly accessToken: string
  /**
   * Absent when Google declined to issue one — which happens when the merchant
   * has granted this app before and the consent screen was skipped. Without it
   * we cannot sync after the access token expires, so the connect flow asks for
   * consent explicitly rather than discovering the gap days later.
   */
  readonly refreshToken: string | null
  readonly expiresAt: Date
  readonly scope: string
}

export interface GscSite {
  /** Either `sc-domain:example.com` or a URL prefix such as `https://www.example.com/`. */
  readonly siteUrl: string
  /** Google's own word for what this Google account may do with the property, e.g. `siteOwner`. */
  readonly permissionLevel: string
}

/** One row of the Search Analytics report, already flattened out of Google's parallel `keys` array. */
export interface GscSearchAnalyticsRow {
  readonly date: string
  readonly page: string
  readonly query: string
  readonly device: string
  readonly country: string
  readonly clicks: number
  readonly impressions: number
  readonly position: number
}

export interface GscSearchAnalyticsRequest {
  readonly siteUrl: string
  /** Inclusive, `YYYY-MM-DD`, in the property's own (Pacific) reporting calendar. */
  readonly startDate: string
  readonly endDate: string
  /** Where in the result set to resume. Google pages by offset, not by cursor. */
  readonly startRow?: number
}

export interface GscSearchAnalyticsPage {
  readonly rows: readonly GscSearchAnalyticsRow[]
  /** True when Google returned a full page, so there is more to ask for. */
  readonly hasMore: boolean
  readonly nextStartRow: number
}

/**
 * Raised when Google says the grant itself is gone — the merchant revoked it,
 * or the refresh token was invalidated. Distinct from a network failure because
 * the answers differ: a network failure is retried, a dead grant is recorded and
 * the merchant is asked to reconnect. Reporting stops; nothing else does.
 */
export class GscGrantRevoked extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions)
    this.name = 'GscGrantRevoked'
  }
}

/** A transport or quota failure. Retrying is worth doing; reconnecting is not. */
export class GscRequestFailure extends Error {
  constructor(
    readonly retryable: boolean,
    readonly errorClass: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions)
    this.name = 'GscRequestFailure'
  }
}

export interface GscProvider {
  /** Where to send the merchant's browser to start the grant. */
  authorizationUrl(input: { state: string; redirectUri: string }): string
  /** Trades the one-time code from the redirect for tokens. */
  exchangeCode(input: { code: string; redirectUri: string }): Promise<GscTokens>
  /** Trades a refresh token for a fresh access token. Throws `GscGrantRevoked` when the grant is gone. */
  refresh(refreshToken: string): Promise<GscTokens>
  /** Every property this Google account can read. */
  listSites(accessToken: string): Promise<readonly GscSite[]>
  /** One page of page × query × device × country rows for a date range. */
  searchAnalytics(
    accessToken: string,
    request: GscSearchAnalyticsRequest,
  ): Promise<GscSearchAnalyticsPage>
  /**
   * Hands the grant back to Google, so a deleted account leaves nothing listed
   * on the merchant's own Google security page.
   *
   * A token Google has already forgotten is not an error, so this is safe to
   * call twice.
   */
  revoke(token: string): Promise<void>
}

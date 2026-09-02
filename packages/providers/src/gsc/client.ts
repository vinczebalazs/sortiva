import {
  GSC_READONLY_SCOPE,
  GscGrantRevoked,
  GscRequestFailure,
  type GscProvider,
  type GscSearchAnalyticsPage,
  type GscSearchAnalyticsRequest,
  type GscSearchAnalyticsRow,
  type GscSite,
  type GscTokens,
} from '@sortiva/core'

/**
 * The one path to Google Search Console. Nothing else in the codebase talks to
 * Google on a merchant's behalf, which keeps three promises in one place rather
 * than at every call site:
 *
 * - **Read-only, and only that.** The single scope requested cannot change
 *   anything in the merchant's property. Signing in to Sortiva asks for identity
 *   alone; this is a separate, later grant, and a merchant who never makes it
 *   keeps a working product.
 * - **A refresh token or nothing.** Google issues one only when it actually
 *   shows the consent screen, and it skips that screen for an app the user has
 *   approved before. Without a refresh token the connection dies at the first
 *   token expiry, an hour later and far from here — so consent is requested
 *   explicitly rather than left to Google's discretion.
 * - **A revoked grant is not a network error.** They need opposite responses:
 *   retry the second; stop and ask the merchant to reconnect for the first.
 *
 * Plain HTTPS rather than Google's SDK: four endpoints, no streaming, no
 * resumable uploads, and one fewer dependency bringing its own transport,
 * retries and token cache to reason about.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const API_BASE = 'https://www.googleapis.com/webmasters/v3'

/**
 * Google's own ceiling on one Search Analytics response. Not a policy number:
 * asking for more is refused by the API, and asking for less would mean more
 * round trips for the same data.
 */
const ROW_LIMIT = 25_000

/** The dimensions detection needs, asked for together so one report fills both tables. */
const DIMENSIONS = ['date', 'page', 'query', 'device', 'country'] as const

export interface GscOAuthProviderOptions {
  clientId?: string
  clientSecret?: string
  fetchImpl?: typeof fetch
  now?: () => number
  authEndpoint?: string
  tokenEndpoint?: string
  apiBase?: string
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

interface SearchAnalyticsResponse {
  rows?: { keys?: string[]; clicks?: number; impressions?: number; position?: number }[]
}

export class GscOAuthProvider implements GscProvider {
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly authEndpoint: string
  private readonly tokenEndpoint: string
  private readonly apiBase: string

  constructor(options: GscOAuthProviderOptions = {}) {
    this.clientId = options.clientId ?? process.env.GSC_OAUTH_CLIENT_ID ?? ''
    this.clientSecret = options.clientSecret ?? process.env.GSC_OAUTH_CLIENT_SECRET ?? ''
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => Date.now())
    this.authEndpoint = options.authEndpoint ?? AUTH_ENDPOINT
    this.tokenEndpoint = options.tokenEndpoint ?? TOKEN_ENDPOINT
    this.apiBase = options.apiBase ?? API_BASE
  }

  authorizationUrl(input: { state: string; redirectUri: string }): string {
    this.requireCredentials()
    const url = new URL(this.authEndpoint)
    url.searchParams.set('client_id', this.clientId)
    url.searchParams.set('redirect_uri', input.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', GSC_READONLY_SCOPE)
    url.searchParams.set('state', input.state)
    // Offline access is what makes a refresh token possible at all; forcing the
    // consent screen is what makes Google actually issue one to a merchant who
    // has connected before. Without both, a reconnection produces a grant that
    // works for an hour and then cannot be renewed.
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')
    url.searchParams.set('include_granted_scopes', 'false')
    return url.toString()
  }

  async exchangeCode(input: { code: string; redirectUri: string }): Promise<GscTokens> {
    return this.token({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
    })
  }

  async refresh(refreshToken: string): Promise<GscTokens> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken })
  }

  async listSites(accessToken: string): Promise<readonly GscSite[]> {
    const body = await this.request<{
      siteEntry?: { siteUrl?: string; permissionLevel?: string }[]
    }>(`${this.apiBase}/sites`, accessToken, { method: 'GET' })

    const entries = body.siteEntry ?? []
    const sites: GscSite[] = []
    for (const entry of entries) {
      if (typeof entry.siteUrl !== 'string') continue
      sites.push({ siteUrl: entry.siteUrl, permissionLevel: entry.permissionLevel ?? 'unknown' })
    }
    return sites
  }

  async searchAnalytics(
    accessToken: string,
    request: GscSearchAnalyticsRequest,
  ): Promise<GscSearchAnalyticsPage> {
    const startRow = request.startRow ?? 0
    const url = `${this.apiBase}/sites/${encodeURIComponent(request.siteUrl)}/searchAnalytics/query`
    const body = await this.request<SearchAnalyticsResponse>(url, accessToken, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        startDate: request.startDate,
        endDate: request.endDate,
        dimensions: [...DIMENSIONS],
        rowLimit: ROW_LIMIT,
        startRow,
        // Web results only. Image and video results click completely
        // differently, and mixing them in would distort the store's own
        // click-through curve, which every low-click-through judgement rests on.
        type: 'web',
        dataState: 'final',
      }),
    })

    const raw = body.rows ?? []
    const rows: GscSearchAnalyticsRow[] = []
    for (const row of raw) {
      const keys = row.keys ?? []
      if (keys.length !== DIMENSIONS.length) continue
      rows.push({
        date: keys[0]!,
        page: keys[1]!,
        query: keys[2]!,
        device: keys[3]!,
        country: keys[4]!,
        clicks: row.clicks ?? 0,
        impressions: row.impressions ?? 0,
        position: row.position ?? 0,
      })
    }

    // Google sends no "more results" marker; a completely full page is the only
    // signal there is. Asking once more for an exactly-full final page costs one
    // request and is the alternative to silently truncating a day's data.
    return { rows, hasMore: raw.length === ROW_LIMIT, nextStartRow: startRow + raw.length }
  }

  private requireCredentials(): void {
    if (!this.clientId || !this.clientSecret) {
      throw new GscRequestFailure(
        false,
        'gsc_not_configured',
        'GSC_OAUTH_CLIENT_ID and GSC_OAUTH_CLIENT_SECRET are not set; Search Console cannot be connected.',
      )
    }
  }

  private async token(params: Record<string, string>): Promise<GscTokens> {
    this.requireCredentials()
    const form = new URLSearchParams({
      ...params,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    })

    let response: Response
    try {
      response = await this.fetchImpl(this.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      })
    } catch (error) {
      throw new GscRequestFailure(
        true,
        'gsc_transport',
        'Could not reach Google to exchange the token.',
        { cause: error },
      )
    }

    const body = (await this.readJson<TokenResponse>(response)) ?? {}

    if (!response.ok) {
      // `invalid_grant` is Google's answer for a revoked, expired or
      // already-spent grant. It is the one failure retrying cannot fix, and the
      // one that has to reach the merchant as "reconnect".
      if (body.error === 'invalid_grant') {
        throw new GscGrantRevoked(
          'Google no longer honours this grant; the merchant has to reconnect Search Console.',
        )
      }
      throw new GscRequestFailure(
        response.status >= 500 || response.status === 429,
        `gsc_token_${response.status}`,
        `Google refused the token request: ${body.error ?? response.status}.`,
      )
    }

    if (!body.access_token) {
      throw new GscRequestFailure(false, 'gsc_token_malformed', 'Google returned no access token.')
    }

    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      // Google reports a lifetime, not an instant. Stored as an instant so a
      // sync can ask "is this still good" without knowing when it was issued.
      expiresAt: new Date(this.now() + (body.expires_in ?? 3600) * 1000),
      scope: body.scope ?? GSC_READONLY_SCOPE,
    }
  }

  private async request<T>(url: string, accessToken: string, init: RequestInit): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: {
          ...((init.headers as Record<string, string> | undefined) ?? {}),
          authorization: `Bearer ${accessToken}`,
        },
      })
    } catch (error) {
      throw new GscRequestFailure(true, 'gsc_transport', 'Could not reach Google Search Console.', {
        cause: error,
      })
    }

    if (response.status === 401 || response.status === 403) {
      throw new GscGrantRevoked(
        `Google refused our access to this property (${response.status}); the merchant has to reconnect Search Console.`,
      )
    }
    if (!response.ok) {
      throw new GscRequestFailure(
        response.status >= 500 || response.status === 429,
        `gsc_http_${response.status}`,
        `Search Console answered ${response.status}.`,
      )
    }

    const body = await this.readJson<T>(response)
    if (body === null) {
      throw new GscRequestFailure(
        true,
        'gsc_malformed',
        'Search Console returned a body we could not read.',
      )
    }
    return body
  }

  private async readJson<T>(response: Response): Promise<T | null> {
    try {
      return (await response.json()) as T
    } catch {
      return null
    }
  }
}

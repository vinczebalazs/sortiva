import {
  GSC_READONLY_SCOPE,
  GscGrantRevoked,
  type GscProvider,
  type GscSearchAnalyticsPage,
  type GscSearchAnalyticsRequest,
  type GscSearchAnalyticsRow,
  type GscSite,
  type GscTokens,
} from '@sortiva/core'

/**
 * The Search Console test double. Local and staging runs use it, so no test
 * needs a Google account and no test run can touch a real merchant's property.
 *
 * It is not a fixture dispenser: it holds rows against dates and serves only the
 * ones inside the window it is asked for, and it pages exactly as Google does.
 * That is what lets a test assert the thing worth asserting about an import —
 * that killing it and resuming does not re-fetch what was already committed, and
 * does not lose the rest.
 */

export interface InMemoryGscOptions {
  sites?: readonly GscSite[]
  rows?: readonly GscSearchAnalyticsRow[]
  /** Rows per page, so a test can force paging without inventing 25,000 rows. */
  pageSize?: number
  /** When set, the grant is treated as revoked from this call onward. */
  revokedAfterCalls?: number
  /** Google withholds a refresh token when it skips the consent screen; this reproduces that. */
  withholdRefreshToken?: boolean
  now?: () => number
}

export class InMemoryGscProvider implements GscProvider {
  readonly authorizationUrls: string[] = []
  readonly analyticsRequests: GscSearchAnalyticsRequest[] = []
  refreshCalls = 0

  private readonly options: InMemoryGscOptions
  private callCount = 0

  constructor(options: InMemoryGscOptions = {}) {
    this.options = options
  }

  authorizationUrl(input: { state: string; redirectUri: string }): string {
    const url = `https://accounts.google.test/authorize?state=${encodeURIComponent(input.state)}&redirect_uri=${encodeURIComponent(input.redirectUri)}&scope=${encodeURIComponent(GSC_READONLY_SCOPE)}`
    this.authorizationUrls.push(url)
    return url
  }

  async exchangeCode(input: { code: string; redirectUri: string }): Promise<GscTokens> {
    if (input.code === 'revoked') {
      throw new GscGrantRevoked('the double was asked to fail the exchange')
    }
    return this.tokens(`access-for-${input.code}`)
  }

  async refresh(refreshToken: string): Promise<GscTokens> {
    this.refreshCalls += 1
    if (refreshToken === 'revoked') {
      throw new GscGrantRevoked('the double was asked to fail the refresh')
    }
    return this.tokens('refreshed-access')
  }

  async listSites(): Promise<readonly GscSite[]> {
    this.countCall()
    return this.options.sites ?? []
  }

  async searchAnalytics(
    _accessToken: string,
    request: GscSearchAnalyticsRequest,
  ): Promise<GscSearchAnalyticsPage> {
    this.countCall()
    this.analyticsRequests.push(request)

    const inWindow = (this.options.rows ?? []).filter(
      (row) => row.date >= request.startDate && row.date <= request.endDate,
    )
    const pageSize = this.options.pageSize ?? inWindow.length
    const startRow = request.startRow ?? 0
    const page = inWindow.slice(startRow, startRow + Math.max(pageSize, 1))

    return {
      rows: page,
      hasMore: startRow + page.length < inWindow.length,
      nextStartRow: startRow + page.length,
    }
  }

  private countCall(): void {
    this.callCount += 1
    const limit = this.options.revokedAfterCalls
    if (limit !== undefined && this.callCount > limit) {
      throw new GscGrantRevoked('the double was asked to revoke the grant part-way through')
    }
  }

  private tokens(accessToken: string): GscTokens {
    const now = this.options.now?.() ?? Date.now()
    return {
      accessToken,
      refreshToken: this.options.withholdRefreshToken ? null : 'refresh-token',
      expiresAt: new Date(now + 3600 * 1000),
      scope: GSC_READONLY_SCOPE,
    }
  }
}

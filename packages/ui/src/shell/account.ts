import type { BannerContext } from './banners'
import type { NavContext } from './nav'

/**
 * Turns what `GET /api/account` answers into the handful of facts the shell
 * actually reasons about.
 *
 * The mapping lives here rather than in the layout so it can be tested against
 * the mock server's own fixture: if the API ever answers a different shape, a
 * test fails here rather than a screen rendering an unlocked rail to somebody
 * whose store is not connected.
 */

export interface ShellAccount {
  /**
   * Who the analytics vendor is told is using the product. Optional because
   * nothing the shell *renders* needs it: an account response without it still
   * draws a correct screen, it simply reports nothing.
   */
  readonly accountId?: string
  readonly domain: { readonly state: string; readonly normalized?: string } | null
  readonly subscription: { readonly status: string }
  readonly limitedIntelligence: boolean
  readonly connections: {
    readonly shopify: string
    readonly searchConsole: string
    readonly lastScanAt: string | null
  }
  readonly servicePaused: boolean
}

const DOMAIN_STATES = [
  'ingesting',
  'awaiting_shopify_auth',
  'needs_confirmation',
  'ready_for_planning',
  'unsupported',
] as const

export function navContextFromAccount(
  account: ShellAccount,
  currentItem?: NavContext['currentItem'],
): NavContext {
  const raw = account.domain?.state
  const domainState = (DOMAIN_STATES as readonly string[]).includes(raw ?? '')
    ? (raw as NavContext['domainState'])
    : 'none'

  return {
    domainState,
    // The account response carries no "the first scan finished" flag of its own.
    // A scan timestamp is the same fact: the onboarding run is what writes the
    // first one, so its absence means the run has not produced anything yet.
    firstScanComplete: account.connections.lastScanAt !== null,
    ...(currentItem ? { currentItem } : {}),
  }
}

export function bannerContextFromAccount(
  account: ShellAccount,
  extras: { readonly vacationMode?: boolean; readonly dismissed?: BannerContext['dismissed'] } = {},
): BannerContext {
  return {
    subscriptionStatus: account.subscription.status as BannerContext['subscriptionStatus'],
    shopifyConnection: account.connections.shopify as BannerContext['shopifyConnection'],
    searchConsoleConnection: account.connections
      .searchConsole as BannerContext['searchConsoleConnection'],
    limitedIntelligence: account.limitedIntelligence,
    servicePaused: account.servicePaused,
    // Vacation mode is a publishing setting, not an account fact, so the caller
    // supplies it from `GET /api/settings`.
    vacationMode: extras.vacationMode ?? false,
    ...(extras.dismissed ? { dismissed: extras.dismissed } : {}),
  }
}

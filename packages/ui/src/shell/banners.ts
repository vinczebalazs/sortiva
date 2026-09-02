import type { StringKey } from '../strings'

/**
 * The strip of account-level notices above every authenticated screen.
 *
 * Two rules shape it. At most two are on screen at once, because a wall of
 * banners is read as decoration and dismissed as a block — the rest are counted
 * and left in the notifications list. And the ones that stop the product
 * working cannot be dismissed at all, because a merchant who hides "payment
 * failed" then waits for articles that will never come.
 */

export type BannerId =
  | 'payment_failed'
  | 'shopify_reconnect'
  | 'service_paused'
  | 'vacation_mode'
  | 'gsc_reconnect'
  | 'limited_intelligence'

export type BannerTone = 'critical' | 'warning' | 'neutral'

export interface BannerDefinition {
  readonly id: BannerId
  readonly tone: BannerTone
  readonly messageKey: StringKey
  readonly actionKey?: StringKey
  readonly actionHref?: string
  /**
   * Dismissible banners come back on the next session. Nothing here is
   * dismissible for good: the condition returning is what makes it reappear.
   */
  readonly dismissible: boolean
}

/**
 * Priority order, highest first. Money before a broken connection before an
 * outage on our side, then the two that are merely worth knowing. This is the
 * order the two visible slots are filled in.
 */
export const BANNERS: readonly BannerDefinition[] = [
  {
    id: 'payment_failed',
    tone: 'critical',
    messageKey: 'banner.paymentFailed',
    actionKey: 'banner.paymentFailed.action',
    actionHref: '/settings/billing',
    dismissible: false,
  },
  {
    id: 'shopify_reconnect',
    tone: 'warning',
    messageKey: 'banner.shopifyReconnect',
    actionKey: 'banner.shopifyReconnect.action',
    actionHref: '/settings/connections',
    dismissible: false,
  },
  {
    id: 'service_paused',
    tone: 'neutral',
    messageKey: 'banner.servicePaused',
    // No action: the merchant cannot fix something on our side, and offering a
    // button that does nothing is worse than offering none.
    dismissible: false,
  },
  {
    id: 'vacation_mode',
    tone: 'neutral',
    messageKey: 'banner.vacationMode',
    actionKey: 'banner.vacationMode.action',
    actionHref: '/settings/publishing',
    dismissible: false,
  },
  {
    id: 'gsc_reconnect',
    tone: 'warning',
    messageKey: 'banner.gscReconnect',
    actionKey: 'banner.gscReconnect.action',
    actionHref: '/settings/connections',
    dismissible: true,
  },
  {
    id: 'limited_intelligence',
    tone: 'neutral',
    messageKey: 'appendixA.limitedModeBadge',
    actionKey: 'banner.limitedIntelligence.action',
    actionHref: '/settings/connections',
    dismissible: true,
  },
]

/** How many banners are ever on screen at once. The rest are counted, not shown. */
export const MAX_VISIBLE_BANNERS = 2

/** The account facts that raise a banner, assembled by the shell from what it fetched. */
export interface BannerContext {
  readonly subscriptionStatus:
    | 'active'
    | 'past_due'
    | 'canceled'
    | 'incomplete'
    | 'incomplete_expired'
    | 'none'
  readonly shopifyConnection: 'none' | 'read' | 'read_write' | 'broken'
  readonly searchConsoleConnection: 'none' | 'connected' | 'broken'
  readonly limitedIntelligence: boolean
  readonly servicePaused: boolean
  readonly vacationMode: boolean
  /** Ids the merchant dismissed this session. */
  readonly dismissed?: readonly BannerId[]
}

function isRaised(id: BannerId, context: BannerContext): boolean {
  switch (id) {
    case 'payment_failed':
      // Stripe is still retrying the card while the status is `past_due`, so
      // this is the window in which updating it actually helps.
      return context.subscriptionStatus === 'past_due'
    case 'shopify_reconnect':
      return context.shopifyConnection === 'broken'
    case 'service_paused':
      return context.servicePaused
    case 'vacation_mode':
      return context.vacationMode
    case 'gsc_reconnect':
      return context.searchConsoleConnection === 'broken'
    case 'limited_intelligence':
      // A broken connection has its own banner; showing both would say the same
      // thing twice.
      return context.limitedIntelligence && context.searchConsoleConnection !== 'broken'
  }
}

export interface BannerStackState {
  /** In priority order, never more than `MAX_VISIBLE_BANNERS` of them. */
  readonly visible: readonly BannerDefinition[]
  /**
   * Raised but pushed out of the two slots. They are counted so the strip can
   * say how many are waiting in the notifications list, rather than hiding them
   * with no trace.
   */
  readonly overflow: readonly BannerDefinition[]
}

export function resolveBannerStack(context: BannerContext): BannerStackState {
  const dismissed = new Set(context.dismissed ?? [])
  const raised = BANNERS.filter(
    (banner) => isRaised(banner.id, context) && !(banner.dismissible && dismissed.has(banner.id)),
  )
  return {
    visible: raised.slice(0, MAX_VISIBLE_BANNERS),
    overflow: raised.slice(MAX_VISIBLE_BANNERS),
  }
}

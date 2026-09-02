import type { StringKey } from '../strings'

/**
 * The authenticated app's six destinations, in the order they appear. Six was a
 * decision, not an accident: the alternative put Search Console and AI
 * visibility on screens of their own, and Search Console is instead a tab
 * inside Performance.
 */
export type NavItemId =
  | 'dashboard'
  | 'opportunities'
  | 'content'
  | 'products'
  | 'performance'
  | 'settings'

export interface NavItem {
  readonly id: NavItemId
  readonly href: string
  readonly labelKey: StringKey
  /**
   * Whether this destination is one of the four that stay visible but inert
   * until the merchant's store is connected. Dashboard is where the merchant
   * connects it and Settings is where they reach billing and their own account,
   * so neither locks — locking either would strand somebody with no way
   * forward.
   */
  readonly locksBeforeStoreConnected: boolean
  /**
   * On a phone the last two destinations fold into a "More" control, so the
   * bottom bar carries four tabs rather than six.
   */
  readonly collapsesOnMobile: boolean
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'dashboard', href: '/dashboard', labelKey: 'nav.dashboard', locksBeforeStoreConnected: false, collapsesOnMobile: false },
  { id: 'opportunities', href: '/opportunities', labelKey: 'nav.opportunities', locksBeforeStoreConnected: true, collapsesOnMobile: false },
  { id: 'content', href: '/content', labelKey: 'nav.content', locksBeforeStoreConnected: true, collapsesOnMobile: false },
  { id: 'products', href: '/products', labelKey: 'nav.products', locksBeforeStoreConnected: true, collapsesOnMobile: false },
  { id: 'performance', href: '/performance', labelKey: 'nav.performance', locksBeforeStoreConnected: true, collapsesOnMobile: true },
  { id: 'settings', href: '/settings', labelKey: 'nav.settings', locksBeforeStoreConnected: false, collapsesOnMobile: true },
]

/** Everything the navigation needs to know about the account, and nothing else. */
export interface NavContext {
  /**
   * Where the merchant is in connecting their store. Only `ready_for_planning`
   * unlocks the four product surfaces.
   */
  readonly domainState:
    | 'none'
    | 'ingesting'
    | 'awaiting_shopify_auth'
    | 'needs_confirmation'
    | 'ready_for_planning'
    | 'unsupported'
  /**
   * True once the first opportunity scan has produced something. Until then
   * Opportunities is unlocked but still filling, and says so.
   */
  readonly firstScanComplete: boolean
  readonly currentItem?: NavItemId
}

export type NavItemStatus = 'current' | 'available' | 'locked'

export interface ResolvedNavItem extends NavItem {
  readonly status: NavItemStatus
  /** Shown on a locked item, explaining what would unlock it. */
  readonly lockedReasonKey?: StringKey
  /**
   * Opportunities carries a progress note while the first scan runs, so an
   * empty screen reads as "still working" rather than "nothing found".
   */
  readonly pendingKey?: StringKey
}

export function resolveNav(context: NavContext): readonly ResolvedNavItem[] {
  const storeConnected = context.domainState === 'ready_for_planning'

  return NAV_ITEMS.map((item) => {
    const locked = item.locksBeforeStoreConnected && !storeConnected

    if (locked) {
      return { ...item, status: 'locked' as const, lockedReasonKey: 'nav.lockedTooltip' as const }
    }

    const status: NavItemStatus = context.currentItem === item.id ? 'current' : 'available'

    if (item.id === 'opportunities' && storeConnected && !context.firstScanComplete) {
      return { ...item, status, pendingKey: 'nav.opportunitiesPending' as const }
    }

    return { ...item, status }
  })
}

/** True while a locked item should reject clicks as well as look inert. */
export function isInteractive(item: ResolvedNavItem): boolean {
  return item.status !== 'locked'
}

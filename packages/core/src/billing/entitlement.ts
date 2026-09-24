import { ENTITLEMENT_INACTIVE_CODE } from '../api/errors'
import { PAYMENT_FAILED_BANNER } from './copy'

/**
 * `none` is not a Stripe status — it is the absence of a row, which is every
 * account between signup and Checkout.
 */
export type SubscriptionStatus =
  | 'active'
  /**
   * Entitled without paying: the pilot store, partner stores and our own. A
   * comped row has no payment behind it, so it carries no Stripe ids and no
   * period end, and nothing about it expires on its own — it stays until
   * somebody takes it away by hand.
   */
  | 'comped'
  | 'past_due'
  | 'canceled'
  /**
   * The merchant's first payment is still being authorised. A fifth value the
   * spec text does not list — see the note on the database enum in
   * `packages/db/src/schema/enums.ts`. Not entitled, so it changes no gate.
   */
  | 'incomplete'
  | 'incomplete_expired'

export type EntitlementStatus = SubscriptionStatus | 'none'

/** The local row, and nothing else. Invariant 16: never a Stripe API call. */
export interface LocalSubscription {
  readonly status: SubscriptionStatus
  readonly cancelAtPeriodEnd: boolean
  readonly currentPeriodEnd: Date | null
}

/**
 * Entitled means `active` or `comped`, and nothing else. The absence of a row
 * is not entitlement, which is what keeps a store nobody has decided about from
 * quietly getting the product for free.
 *
 * Deliberately not a date comparison. A subscription cancelled at period end
 * stays `active` in Stripe until the period actually ends, and Stripe then
 * sends `customer.subscription.updated` moving it to `canceled`. Re-deriving
 * that here from `current_period_end` would put a second opinion next to the
 * source of truth and get it wrong every time a clock or a retry disagrees.
 * `comped` has no period at all for the same reason: it ends when a person ends
 * it, not when a clock runs out.
 */
export function isEntitled(subscription: LocalSubscription | null | undefined): boolean {
  return subscription?.status === 'active' || subscription?.status === 'comped'
}

export function entitlementStatus(
  subscription: LocalSubscription | null | undefined,
): EntitlementStatus {
  return subscription?.status ?? 'none'
}

/** The banner the shell renders above everything else. */
export type BillingBanner =
  | { readonly kind: 'none' }
  | {
      /** `past_due`: non-dismissible, links to the Customer Portal. */
      readonly kind: 'payment_failed'
      readonly message: string
      readonly dismissible: false
    }
  | { readonly kind: 'canceled' }
  | { readonly kind: 'ending'; readonly endsAt: Date | null }

/**
 * Invariant 16 in one object: billing state gates generation and publishing
 * **only**, and read access is never revoked. Every consumer — the daily
 * scheduler, the auto-publish and export actions, the
 * dashboard shell — asks this function rather than comparing statuses itself,
 * so there is one place where "what does past_due mean" is decided.
 */
export interface BillingGate {
  readonly status: EntitlementStatus
  /** The scheduler checks this exactly like a kill switch. */
  readonly generationAllowed: boolean
  /** Auto-publish and export check it API-side, not only in the UI. */
  readonly publishingAllowed: boolean
  /** Always true. Billing state never takes away access to what we already made for someone. */
  readonly readAllowed: true
  readonly banner: BillingBanner
}

export function billingGate(subscription: LocalSubscription | null | undefined): BillingGate {
  const status = entitlementStatus(subscription)
  const entitled = isEntitled(subscription)
  return {
    status,
    generationAllowed: entitled,
    publishingAllowed: entitled,
    readAllowed: true,
    banner: bannerFor(subscription, status),
  }
}

function bannerFor(
  subscription: LocalSubscription | null | undefined,
  status: EntitlementStatus,
): BillingBanner {
  if (status === 'past_due') {
    return { kind: 'payment_failed', message: PAYMENT_FAILED_BANNER, dismissible: false }
  }
  // `incomplete` is deliberately absent: the merchant's first payment is still
  // being authorised, so telling them the plan is cancelled would be wrong.
  // That window is what the "setting up your account…" interstitial covers,
  // and it resolves to `active` or `incomplete_expired` on its own.
  if (status === 'canceled' || status === 'incomplete_expired') return { kind: 'canceled' }
  // `comped` shows no banner at all. There is nothing for the merchant to fix,
  // nothing to renew and nothing ending, and a banner about billing on an
  // account nobody is billing would only invite a support question.
  if (status === 'active' && subscription?.cancelAtPeriodEnd) {
    // Entitlement runs to the end of the period they paid for; the three
    // cancellation facts render alongside this.
    return { kind: 'ending', endsAt: subscription.currentPeriodEnd ?? null }
  }
  return { kind: 'none' }
}

/**
 * DECISIONS 2026-08-31 T0.7 — entitlement failure is a **402** carrying
 * `entitlement_inactive`, not a 409: nothing about the resource's state
 * conflicts, the account simply is not entitled to start new work.
 *
 * Only routes the frozen route table marks `requiresEntitlement` may throw it,
 * and no GET carries that flag (invariant 16).
 */
export class EntitlementInactiveError extends Error {
  readonly code = ENTITLEMENT_INACTIVE_CODE
  readonly httpStatus = 402
  constructor(readonly status: EntitlementStatus) {
    super('Your subscription is not active, so new work cannot start.')
    this.name = 'EntitlementInactiveError'
  }
}

export function assertEntitled(subscription: LocalSubscription | null | undefined): void {
  if (!isEntitled(subscription)) throw new EntitlementInactiveError(entitlementStatus(subscription))
}

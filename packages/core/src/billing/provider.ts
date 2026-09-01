import type { SubscriptionStatus } from './entitlement'

/**
 * main §4.2, tech §3 — Checkout, Customer Portal, webhook signature
 * verification and the nightly re-fetch are the *only* things we ask Stripe.
 * Everything else reads the local `subscriptions` row (invariant 16).
 *
 * The port is described in our own types, never Stripe's, so `packages/core`
 * stays free of the vendor SDK (a boundary test proves it) and the mock in
 * `packages/providers` is a peer of the real client rather than a subclass.
 */

/** The subscription state as Stripe holds it, flattened to what §13 stores. */
export interface RemoteSubscription {
  readonly subscriptionId: string
  readonly customerId: string
  readonly status: SubscriptionStatus
  readonly priceId: string
  readonly currentPeriodEnd: Date | null
  readonly cancelAtPeriodEnd: boolean
}

/** A signature-verified Stripe event, still in Stripe's own JSON shape. */
export interface StripeEventEnvelope {
  readonly id: string
  readonly type: string
  /** Stripe's own creation time. The ordering key for out-of-order delivery. */
  readonly created: Date
  readonly payload: Record<string, unknown>
}

export interface CheckoutSessionRequest {
  /** Rides on `client_reference_id` so the webhook can resolve the account. */
  readonly accountId: string
  readonly email: string
  readonly priceId: string
  /** Reuses the Stripe customer when this account already has one. */
  readonly customerId?: string
  readonly successUrl: string
  readonly cancelUrl: string
  /**
   * main §14.3.2 — derived from the inputs, never random, so a double-clicked
   * Subscribe button cannot open two Checkout sessions.
   */
  readonly idempotencyKey: string
}

export interface CheckoutSession {
  readonly sessionId: string
  readonly url: string
}

export interface PortalSessionRequest {
  readonly customerId: string
  readonly returnUrl: string
}

export interface PortalSession {
  readonly url: string
}

/** What a Stripe Price says an amount is. Minor units, because Stripe uses them. */
export interface RemotePrice {
  readonly priceId: string
  /** Cents, or the currency's own smallest unit. Null for a metered price. */
  readonly unitAmountMinor: number | null
  /** ISO 4217, lower-case as Stripe returns it. */
  readonly currency: string
}

export interface StripeBillingProvider {
  createCheckoutSession(request: CheckoutSessionRequest): Promise<CheckoutSession>
  createPortalSession(request: PortalSessionRequest): Promise<PortalSession>
  /** Throws `WebhookSignatureError` when the signature does not verify. */
  constructEvent(rawBody: string, signature: string | null): StripeEventEnvelope
  /** tech §3 — the nightly reconciliation's one call. Null when Stripe has no such subscription. */
  fetchSubscription(subscriptionId: string): Promise<RemoteSubscription | null>
  /**
   * The amounts behind the two configured price ids, for the plan screen.
   *
   * main §4.2 — "amounts live in Stripe only — the app never hardcodes a dollar
   * amount", so the only way to show a price is to ask Stripe what it is.
   *
   * A price id Stripe does not have is simply absent from the answer rather than
   * an error, so a misconfigured id pauses the plan screen instead of showing
   * half a plan — main §14.4's "degrade to pause" rather than inventing an
   * amount.
   */
  fetchPrices(priceIds: readonly string[]): Promise<readonly RemotePrice[]>
}

export class WebhookSignatureError extends Error {
  constructor(message = 'Stripe webhook signature verification failed') {
    super(message)
    this.name = 'WebhookSignatureError'
  }
}

export class StripeCallFailed extends Error {
  constructor(
    readonly operation: string,
    cause: unknown,
  ) {
    super(`Stripe ${operation} failed: ${String(cause)}`)
    this.name = 'StripeCallFailed'
    this.cause = cause
  }
}

/**
 * Stripe has nine subscription statuses; we store five. The mapping is lossy on
 * purpose, and the loss is safe because only two distinctions drive behaviour:
 * `active` is the one entitled state (main §4.2), and `past_due` is the one
 * that raises the dunning banner and email. Everything else means "not
 * entitled, no dunning".
 *
 * `incomplete` — "the first payment has not completed yet", which can still
 * succeed — now keeps its own value instead of landing under
 * `incomplete_expired`. Collapsing the two recorded a merchant mid-purchase as
 * one who gave up, and then counted them as churn on main §14.7's
 * `subscription_canceled` funnel event from the moment their row was created.
 * See DECISIONS 2026-09-01 T1.2a.
 */
export function mapStripeStatus(status: string): SubscriptionStatus {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active'
    case 'past_due':
    case 'unpaid':
      return 'past_due'
    case 'canceled':
    case 'paused':
      return 'canceled'
    case 'incomplete':
      return 'incomplete'
    case 'incomplete_expired':
      return 'incomplete_expired'
    default:
      // A status Stripe adds after this was written must not silently read as
      // entitled. Not entitled is the safe default in both directions: we never
      // give away generation, and read access is never revoked anyway.
      return 'incomplete_expired'
  }
}

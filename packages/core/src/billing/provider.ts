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

export interface StripeBillingProvider {
  createCheckoutSession(request: CheckoutSessionRequest): Promise<CheckoutSession>
  createPortalSession(request: PortalSessionRequest): Promise<PortalSession>
  /** Throws `WebhookSignatureError` when the signature does not verify. */
  constructEvent(rawBody: string, signature: string | null): StripeEventEnvelope
  /** tech §3 — the nightly reconciliation's one call. Null when Stripe has no such subscription. */
  fetchSubscription(subscriptionId: string): Promise<RemoteSubscription | null>
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
 * Stripe has nine subscription statuses; main §13 stores four. The mapping is
 * lossy on purpose, and the loss is safe because only two distinctions drive
 * behaviour: `active` is the one entitled state (main §4.2), and `past_due` is
 * the one that raises the dunning banner and email. Everything else means
 * "not entitled, no dunning".
 *
 * `incomplete` is the one genuinely awkward case — Stripe's "the first payment
 * has not completed yet", which can still succeed — and it lands under
 * `incomplete_expired` because §13's enum has no cell for it. No user-facing
 * copy distinguishes the two, and both gate identically. See DECISIONS
 * 2026-08-31 T1.2.
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
    case 'incomplete_expired':
      return 'incomplete_expired'
    default:
      // A status Stripe adds after this was written must not silently read as
      // entitled. Not entitled is the safe default in both directions: we never
      // give away generation, and read access is never revoked anyway.
      return 'incomplete_expired'
  }
}

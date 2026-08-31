import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  WebhookSignatureError,
  type CheckoutSession,
  type CheckoutSessionRequest,
  type PortalSession,
  type PortalSessionRequest,
  type RemoteSubscription,
  type StripeBillingProvider,
  type StripeEventEnvelope,
} from '@sortiva/core'

/**
 * Test double, in the shape T0.5 set for every provider: a peer of the real
 * client that enforces the contracts that matter rather than merely recording
 * calls.
 *
 * Two of those contracts are enforced here because getting them wrong in
 * production is expensive and silent:
 *
 *  - **Idempotency.** A repeated `idempotencyKey` returns the first session, as
 *    Stripe does, so a test of a double-clicked Subscribe button sees
 *    production behaviour (main §14.3.2).
 *  - **Signature verification.** `sign()` produces a real `t=…,v1=…` header
 *    using Stripe's own HMAC-SHA256 scheme over `${timestamp}.${body}`, and
 *    `constructEvent` verifies it the same way. A receiver test therefore
 *    exercises the actual verify-then-store path, and a forged body fails here
 *    exactly as it would against Stripe.
 */
export class MockStripeProvider implements StripeBillingProvider {
  readonly checkoutSessions: CheckoutSessionRequest[] = []
  readonly portalSessions: PortalSessionRequest[] = []

  private readonly byIdempotencyKey = new Map<string, CheckoutSession>()
  private readonly subscriptions = new Map<string, RemoteSubscription>()
  private nextFailure: Error | undefined

  constructor(readonly webhookSecret = 'whsec_mock') {}

  /** Seeds what `fetchSubscription` will return — the reconciliation's input. */
  setSubscription(subscription: RemoteSubscription): void {
    this.subscriptions.set(subscription.subscriptionId, subscription)
  }

  removeSubscription(subscriptionId: string): void {
    this.subscriptions.delete(subscriptionId)
  }

  /** The next remote call throws this. Drives the failure paths. */
  failNext(error: Error): void {
    this.nextFailure = error
  }

  reset(): void {
    this.checkoutSessions.length = 0
    this.portalSessions.length = 0
    this.byIdempotencyKey.clear()
    this.subscriptions.clear()
    this.nextFailure = undefined
  }

  private throwIfPrimed(): void {
    if (!this.nextFailure) return
    const failure = this.nextFailure
    this.nextFailure = undefined
    throw failure
  }

  async createCheckoutSession(request: CheckoutSessionRequest): Promise<CheckoutSession> {
    this.throwIfPrimed()
    const existing = this.byIdempotencyKey.get(request.idempotencyKey)
    if (existing) return existing
    const session: CheckoutSession = {
      sessionId: `cs_mock_${this.byIdempotencyKey.size + 1}`,
      url: `https://checkout.stripe.test/${this.byIdempotencyKey.size + 1}`,
    }
    this.byIdempotencyKey.set(request.idempotencyKey, session)
    this.checkoutSessions.push(request)
    return session
  }

  async createPortalSession(request: PortalSessionRequest): Promise<PortalSession> {
    this.throwIfPrimed()
    this.portalSessions.push(request)
    return { url: `https://billing.stripe.test/${request.customerId}` }
  }

  /** Produces the `stripe-signature` header for a body, as Stripe would. */
  sign(rawBody: string, timestampSeconds = Math.floor(Date.now() / 1000)): string {
    const digest = createHmac('sha256', this.webhookSecret)
      .update(`${timestampSeconds}.${rawBody}`)
      .digest('hex')
    return `t=${timestampSeconds},v1=${digest}`
  }

  constructEvent(rawBody: string, signature: string | null): StripeEventEnvelope {
    if (!signature) throw new WebhookSignatureError('missing stripe-signature header')
    const parts = Object.fromEntries(
      signature.split(',').map((part) => {
        const index = part.indexOf('=')
        return [part.slice(0, index), part.slice(index + 1)]
      }),
    )
    const timestamp = parts['t']
    const provided = parts['v1']
    if (!timestamp || !provided) throw new WebhookSignatureError('malformed stripe-signature')

    const expected = createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex')
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new WebhookSignatureError('signature mismatch')
    }

    const parsed = JSON.parse(rawBody) as Record<string, unknown>
    const created = parsed['created']
    return {
      id: String(parsed['id'] ?? ''),
      type: String(parsed['type'] ?? ''),
      created:
        typeof created === 'number' ? new Date(created * 1000) : new Date(Number(timestamp) * 1000),
      payload: parsed,
    }
  }

  async fetchSubscription(subscriptionId: string): Promise<RemoteSubscription | null> {
    this.throwIfPrimed()
    return this.subscriptions.get(subscriptionId) ?? null
  }
}

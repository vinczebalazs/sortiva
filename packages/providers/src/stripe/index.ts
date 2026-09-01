import Stripe from 'stripe'
import {
  mapStripeStatus,
  StripeCallFailed,
  WebhookSignatureError,
  type CheckoutSession,
  type CheckoutSessionRequest,
  type PortalSession,
  type PortalSessionRequest,
  type RemotePrice,
  type RemoteSubscription,
  type StripeBillingProvider,
  type StripeEventEnvelope,
} from '@sortiva/core'

/**
 * main §4.2, tech §3 — the only four things we ask Stripe: open a Checkout
 * session, open a Customer Portal session, verify a webhook signature, and
 * re-read a subscription for the nightly reconciliation.
 *
 * This is the one file in the repo allowed to import the Stripe SDK; the lint
 * rule `sortiva/no-direct-provider-sdk` enforces that everywhere else
 * (invariant 25), and `billing/stripeCallSites.test.ts` additionally proves no
 * *call* to this wrapper's remote methods escapes the three sanctioned sites.
 */

export interface StripeProviderOptions {
  secretKey?: string
  webhookSecret?: string
  client?: Stripe
}

export class StripeProvider implements StripeBillingProvider {
  private readonly client: Stripe
  private readonly webhookSecret: string

  constructor(options: StripeProviderOptions = {}) {
    const secretKey = options.secretKey ?? process.env.STRIPE_SECRET_KEY
    if (!options.client && !secretKey) {
      throw new Error('STRIPE_SECRET_KEY is not set. Use MockStripeProvider outside production.')
    }
    this.client = options.client ?? new Stripe(secretKey as string)
    this.webhookSecret = options.webhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET ?? ''
  }

  async createCheckoutSession(request: CheckoutSessionRequest): Promise<CheckoutSession> {
    let session: Stripe.Checkout.Session
    try {
      session = await this.client.checkout.sessions.create(
        {
          mode: 'subscription',
          line_items: [{ price: request.priceId, quantity: 1 }],
          // How the webhook finds the account: main §4.2's
          // "attach customer + subscription to account".
          client_reference_id: request.accountId,
          ...(request.customerId
            ? { customer: request.customerId }
            : { customer_email: request.email }),
          success_url: request.successUrl,
          cancel_url: request.cancelUrl,
          metadata: { account_id: request.accountId },
        },
        { idempotencyKey: request.idempotencyKey },
      )
    } catch (error) {
      throw new StripeCallFailed('checkout session create', error)
    }
    if (!session.url) throw new StripeCallFailed('checkout session create', 'no url returned')
    return { sessionId: session.id, url: session.url }
  }

  async createPortalSession(request: PortalSessionRequest): Promise<PortalSession> {
    try {
      const session = await this.client.billingPortal.sessions.create({
        customer: request.customerId,
        return_url: request.returnUrl,
      })
      return { url: session.url }
    } catch (error) {
      throw new StripeCallFailed('billing portal session create', error)
    }
  }

  /**
   * tech §3 — signature verification before anything touches the body. A
   * forged payload must never reach the event store, because the store is what
   * the status worker trusts.
   */
  constructEvent(rawBody: string, signature: string | null): StripeEventEnvelope {
    if (!this.webhookSecret) throw new WebhookSignatureError('STRIPE_WEBHOOK_SECRET is not set')
    if (!signature) throw new WebhookSignatureError('missing stripe-signature header')
    let event: Stripe.Event
    try {
      event = this.client.webhooks.constructEvent(rawBody, signature, this.webhookSecret)
    } catch (error) {
      throw new WebhookSignatureError(`Stripe rejected the signature: ${String(error)}`)
    }
    return {
      id: event.id,
      type: event.type,
      created: new Date(event.created * 1000),
      payload: event as unknown as Record<string, unknown>,
    }
  }

  async fetchSubscription(subscriptionId: string): Promise<RemoteSubscription | null> {
    let subscription: Stripe.Subscription
    try {
      subscription = await this.client.subscriptions.retrieve(subscriptionId)
    } catch (error) {
      if (isNotFound(error)) return null
      throw new StripeCallFailed('subscription retrieve', error)
    }
    return toRemoteSubscription(subscription)
  }

  async fetchPrices(priceIds: readonly string[]): Promise<readonly RemotePrice[]> {
    const found = await Promise.all(
      priceIds.map(async (priceId) => {
        try {
          return await this.client.prices.retrieve(priceId)
        } catch (error) {
          // A configured price id Stripe does not have is a configuration
          // mistake, not a reason to show half a plan. Returning nothing for it
          // lets the caller pause the screen rather than invent an amount.
          if (isNotFound(error)) return null
          throw new StripeCallFailed('price retrieve', error)
        }
      }),
    )
    return found.filter((price) => price !== null).map(toRemotePrice)
  }
}

function toRemotePrice(price: Stripe.Price): RemotePrice {
  return {
    priceId: price.id,
    unitAmountMinor: price.unit_amount,
    currency: price.currency,
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'resource_missing'
  )
}

function toRemoteSubscription(subscription: Stripe.Subscription): RemoteSubscription {
  const item = subscription.items?.data?.[0]
  // The billing period moved from the subscription onto its items in Stripe's
  // 2025 API versions; reading both survives an API-version bump.
  const periodEnd =
    (subscription as unknown as { current_period_end?: number }).current_period_end ??
    (item as unknown as { current_period_end?: number } | undefined)?.current_period_end
  return {
    subscriptionId: subscription.id,
    customerId:
      typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id,
    status: mapStripeStatus(subscription.status),
    priceId: item?.price?.id ?? '',
    currentPeriodEnd: typeof periodEnd === 'number' ? new Date(periodEnd * 1000) : null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
  }
}

export * from './mock'

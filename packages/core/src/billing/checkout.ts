import { accountAttribution, type PosthogCapture } from '../contracts/analytics'
import { priceIdFor, type BillingInterval, type PriceCatalog } from './plan'
import type { StripeBillingProvider } from './provider'

/**
 * main §4.2 — "**Stripe Checkout** for purchase and **Stripe Customer Portal**
 * for everything after (card updates, invoices, cancel). Our app never renders
 * a card form." These two functions are the only places in the product that
 * start a payment surface, and neither of them reads or writes entitlement.
 */

export const CHECKOUT_STARTED_EVENT = 'checkout_started'

export interface CheckoutDeps {
  readonly stripe: Pick<StripeBillingProvider, 'createCheckoutSession'>
  readonly prices: PriceCatalog
  /** Absolute base URL of the app; Stripe needs absolute return URLs. */
  readonly appUrl: string
  readonly capture?: Pick<PosthogCapture, 'capture'>
}

export interface CheckoutRequest {
  readonly accountId: string
  readonly email: string
  readonly interval: BillingInterval
  /** Set once this account has been through Checkout before (main §13 `accounts`). */
  readonly customerId?: string | null
}

/**
 * ui §2.3 — success returns to onboarding, cancel returns to the plan screen
 * with the neutral "no charge was made" note.
 */
export function checkoutReturnUrls(appUrl: string): { successUrl: string; cancelUrl: string } {
  const base = appUrl.replace(/\/+$/, '')
  return {
    successUrl: `${base}/dashboard?checkout=success`,
    cancelUrl: `${base}/plan?checkout=canceled`,
  }
}

export async function startCheckout(
  deps: CheckoutDeps,
  request: CheckoutRequest,
): Promise<{ url: string }> {
  const priceId = priceIdFor(deps.prices, request.interval)
  const { successUrl, cancelUrl } = checkoutReturnUrls(deps.appUrl)

  const session = await deps.stripe.createCheckoutSession({
    accountId: request.accountId,
    email: request.email,
    priceId,
    ...(request.customerId ? { customerId: request.customerId } : {}),
    successUrl,
    cancelUrl,
    // main §14.3.2 — derived from the inputs, never random. A double-submitted
    // Subscribe button therefore returns the same Checkout session rather than
    // opening a second one against the same account.
    idempotencyKey: `checkout:${request.accountId}:${priceId}`,
  })

  deps.capture?.capture({
    event: CHECKOUT_STARTED_EVENT,
    attribution: accountAttribution(request.accountId),
    properties: { interval: request.interval, price_id: priceId },
  })

  return { url: session.url }
}

/**
 * The account has never completed Checkout, so Stripe holds no customer to open
 * a Portal for. Not a 409: no guarded transition failed (tech §3), and not a
 * 402 either — the account is not being refused work, there is simply nothing
 * to manage.
 */
export class BillingNotSetUp extends Error {
  readonly code = 'billing_not_set_up'
  readonly httpStatus = 404
  constructor() {
    super('This account has no billing set up yet.')
    this.name = 'BillingNotSetUp'
  }
}

export interface PortalDeps {
  readonly stripe: Pick<StripeBillingProvider, 'createPortalSession'>
  readonly appUrl: string
}

/**
 * main §4.2, §14.6 — cancellation happens here, in Stripe's Portal, as
 * `cancel_at_period_end`. We never build a cancel button of our own, so the
 * three cancellation facts (Appendix A) are what the return screen states.
 */
export async function openBillingPortal(
  deps: PortalDeps,
  request: { customerId: string | null | undefined },
): Promise<{ url: string }> {
  if (!request.customerId) throw new BillingNotSetUp()
  const base = deps.appUrl.replace(/\/+$/, '')
  const session = await deps.stripe.createPortalSession({
    customerId: request.customerId,
    returnUrl: `${base}/settings/account?billing=returned`,
  })
  return { url: session.url }
}

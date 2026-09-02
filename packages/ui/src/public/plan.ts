/**
 * The single plan, as `GET /api/billing/plan` describes it.
 *
 * Everything a merchant reads on the plan card arrives in this response: the
 * cap line word for word, the inclusions, the cancellation facts, and the live
 * amounts. Nothing on the card is written in the component, because the
 * sentences are fixed by the product spec and the amounts are fixed by Stripe.
 */

export type BillingInterval = 'monthly' | 'annual'

export interface PlanPrice {
  readonly interval: BillingInterval
  readonly priceId: string
  readonly unitAmountMinor: number | null
  readonly currency: string
}

export interface PlanResponse {
  readonly planKey: 'pro'
  readonly name: string
  /** "Up to 1 article per day, quality permitting" — a quality promise, not a count. */
  readonly capLine: string
  readonly inclusions: readonly string[]
  readonly cancelAnytime: string
  /** Stated wherever cancellation is offered, not buried in the terms. */
  readonly cancellationFacts: readonly string[]
  readonly prices: readonly PlanPrice[]
}

export const BILLING_INTERVALS: readonly BillingInterval[] = ['monthly', 'annual']

export function priceFor(plan: PlanResponse, interval: BillingInterval): PlanPrice | undefined {
  return plan.prices.find((price) => price.interval === interval)
}

/**
 * Which toggle options to render. Stripe holds two prices on one product, but
 * a product configured with only one must still sell — the toggle simply
 * disappears rather than offering a period that would fail at Checkout.
 */
export function offeredIntervals(plan: PlanResponse): readonly BillingInterval[] {
  return BILLING_INTERVALS.filter((interval) => priceFor(plan, interval) !== undefined)
}

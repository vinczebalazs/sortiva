import { CANCELLATION_FACTS, PLAN_CANCEL_ANYTIME, PLAN_CAP_LINE } from './copy'

/**
 * main §4.2 — one tier, two Stripe Prices (monthly, annual) on one Product.
 * "price IDs are config, amounts live in Stripe only — the app never hardcodes
 * a dollar amount", so nothing on this object is a number.
 */
export type BillingInterval = 'monthly' | 'annual'

export const BILLING_INTERVALS: readonly BillingInterval[] = ['monthly', 'annual']

/** main §4.2 — the plan's inclusions, as ui §2.3 lists them on the card. */
export const PLAN_INCLUSIONS = [
  'Growth opportunities across all action types',
  'Export and auto-publish',
  'Search Console intelligence',
  'Full content calendar',
] as const

export interface PlanScreen {
  readonly planKey: 'pro'
  readonly name: string
  readonly intervals: readonly BillingInterval[]
  /** main Appendix A, verbatim. Never rendered with a denominator (invariant 23). */
  readonly capLine: string
  readonly inclusions: readonly string[]
  readonly cancelAnytime: string
  readonly cancellationFacts: readonly string[]
}

/**
 * The content of ui §2.3's plan card. Amounts are deliberately absent: the
 * screen reads them from the Stripe Price the merchant is about to buy, so
 * repricing is a Stripe change plus a copy change, never a code change
 * (main §4.2).
 */
export const PRO_PLAN: PlanScreen = {
  planKey: 'pro',
  name: 'Pro',
  intervals: BILLING_INTERVALS,
  capLine: PLAN_CAP_LINE,
  inclusions: PLAN_INCLUSIONS,
  cancelAnytime: PLAN_CANCEL_ANYTIME,
  cancellationFacts: CANCELLATION_FACTS,
}

/**
 * main §4.2 — "Two Stripe Prices (monthly, annual) on one Product; price IDs
 * are config". Resolving one is the only thing the Checkout creator needs to
 * know about pricing.
 */
export interface PriceCatalog {
  readonly monthly: string
  readonly annual: string
}

export class UnknownBillingInterval extends Error {
  constructor(interval: string) {
    super(`No Stripe price is configured for the "${interval}" interval`)
    this.name = 'UnknownBillingInterval'
  }
}

export function priceIdFor(catalog: PriceCatalog, interval: BillingInterval): string {
  const priceId = catalog[interval]
  if (!priceId) throw new UnknownBillingInterval(interval)
  return priceId
}

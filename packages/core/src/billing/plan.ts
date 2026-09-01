import type { RemotePrice } from './provider'
import { CANCELLATION_FACTS, PLAN_CANCEL_ANYTIME, PLAN_CAP_LINE } from './copy'
import type { StripeBillingProvider } from './provider'

/**
 * One tier, billed monthly or annually. Price ids are configuration and the
 * amounts live in Stripe only — the app never hardcodes a dollar amount — so
 * nothing on this object is a number.
 */
export type BillingInterval = 'monthly' | 'annual'

export const BILLING_INTERVALS: readonly BillingInterval[] = ['monthly', 'annual']

/** What the plan includes, as the plan card lists them. */
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
 * The plan card's content. Amounts are deliberately absent: the screen reads
 * them from the Stripe price the merchant is about to buy, so repricing is a
 * Stripe change plus a copy change and never a deploy.
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
 * Two prices, monthly and annual, named by configured ids. Resolving one is the
 * only thing the Checkout creator needs to know about pricing.
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

/** One interval's amount, as the plan card renders it. */
export interface PlanPrice {
  readonly interval: BillingInterval
  readonly priceId: string
  /**
   * Minor units (cents), straight from Stripe. Deliberately not formatted here:
   * a formatted string would bake a currency and a locale into the API, and
   * the product has a language dropdown, so the client decides both.
   */
  readonly unitAmountMinor: number | null
  readonly currency: string
}

/** The plan card, with the amounts filled in from Stripe. */
export interface PlanWithPrices extends PlanScreen {
  readonly prices: readonly PlanPrice[]
}

/**
 * Raised when the amounts cannot be read from Stripe — no key, no configured
 * price ids, or a provider that cannot fetch them.
 *
 * No amount may be hardcoded anywhere, so there is no fallback to fall back to:
 * the route answers 503 and the screen says the plan is temporarily
 * unavailable. Degrading to a stale or guessed price on a purchase screen would
 * be worse than showing none.
 */
export class PlanPricesUnavailable extends Error {
  readonly code = 'billing_not_configured'
  constructor(reason: string) {
    super(`Plan prices could not be read from Stripe: ${reason}`)
    this.name = 'PlanPricesUnavailable'
  }
}

export interface PlanPricingDeps {
  readonly stripe: Pick<StripeBillingProvider, 'fetchPrices'>
  readonly prices: PriceCatalog
  readonly now?: () => number
}

/**
 * How long a fetched set of amounts is reused.
 *
 * A price changes when someone edits it in the Stripe dashboard, which is rare
 * and never urgent. Caching keeps the plan screen off Stripe's API on every
 * page view,
 * which matters because this is the one billing route an unpaid visitor hits
 * repeatedly. A cache lifetime, not a rules threshold.
 */
export const PLAN_PRICE_CACHE_MS = 10 * 60 * 1000

interface CacheEntry {
  readonly expiresAt: number
  readonly prices: readonly PlanPrice[]
}

/**
 * Process-local, keyed on the price ids so a config change cannot serve the
 * previous plan's amounts. Deliberately not `request_cache`: that table exists
 * to stop us paying twice for a *billable* vendor read, and a
 * Stripe price lookup is free.
 */
const priceCache = new Map<string, CacheEntry>()

/** Test seam; also the hook a future "price changed" webhook would call. */
export function clearPlanPriceCache(): void {
  priceCache.clear()
}

export async function planWithPrices(deps: PlanPricingDeps): Promise<PlanWithPrices> {
  return { ...PRO_PLAN, prices: await planPrices(deps) }
}

async function planPrices(deps: PlanPricingDeps): Promise<readonly PlanPrice[]> {
  const monthly = priceIdFor(deps.prices, 'monthly')
  const annual = priceIdFor(deps.prices, 'annual')
  const key = `${monthly}|${annual}`
  const now = deps.now?.() ?? Date.now()

  const cached = priceCache.get(key)
  if (cached && cached.expiresAt > now) return cached.prices

  // Whatever stops us reading Stripe — unreachable, a bad key, a rejected
  // request — reaches the screen as one thing: no price, so pause. The screen
  // has nothing useful to do with the difference.
  let remote: readonly RemotePrice[]
  try {
    remote = await deps.stripe.fetchPrices([monthly, annual])
  } catch (error) {
    throw new PlanPricesUnavailable(
      `Stripe prices could not be read: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const byId = new Map(remote.map((price) => [price.priceId, price]))

  const prices = BILLING_INTERVALS.map((interval) => {
    const priceId = interval === 'monthly' ? monthly : annual
    const price = byId.get(priceId)
    if (!price) throw new PlanPricesUnavailable(`Stripe returned no price ${priceId}`)
    return {
      interval,
      priceId,
      unitAmountMinor: price.unitAmountMinor,
      currency: price.currency,
    }
  })

  priceCache.set(key, { expiresAt: now + PLAN_PRICE_CACHE_MS, prices })
  return prices
}

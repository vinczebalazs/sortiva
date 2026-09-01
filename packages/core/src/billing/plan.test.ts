import { beforeEach, describe, expect, it } from 'vitest'
import { CANCELLATION_FACTS, PLAN_CAP_LINE } from './copy'
import {
  clearPlanPriceCache,
  planWithPrices,
  PLAN_PRICE_CACHE_MS,
  PlanPricesUnavailable,
  priceIdFor,
  PRO_PLAN,
  UnknownBillingInterval,
} from './plan'

/**
 * Constitution invariants 23 and 24, and T1.2's done-when: "snapshot asserts the
 * literal cap string".
 *
 * The cap is a **ceiling, not a promise** (main §8.6): some days legitimately
 * produce nothing. Any wording that implies a target — "1/day", "30 per month",
 * "x of y" — would turn a quality guarantee into a quota the product must pad
 * to meet, which main §20 forbids outright.
 */

describe('the plan cap line is canonical copy (main Appendix A)', () => {
  it('is the Appendix A string, verbatim', () => {
    expect(PLAN_CAP_LINE).toMatchInlineSnapshot(`"Up to 1 article per day, quality permitting"`)
  })

  it('matches invariant 16\'s literal, case aside', () => {
    expect(PLAN_CAP_LINE.toLowerCase()).toBe('up to 1 article per day, quality permitting')
  })

  it('is what the plan screen renders', () => {
    expect(PRO_PLAN.capLine).toBe(PLAN_CAP_LINE)
  })

  it('carries no denominator or target (invariant 23)', () => {
    const surfaces = [PRO_PLAN.capLine, ...PRO_PLAN.inclusions, ...PRO_PLAN.cancellationFacts]
    for (const line of surfaces) {
      expect(line).not.toMatch(/\bof\s+\d/i)
      expect(line).not.toMatch(/\d\s*\/\s*\d/)
      expect(line).not.toMatch(/\bper month\b/i)
    }
  })

  it('quotes no price — amounts live in Stripe only (main §4.2)', () => {
    const everything = JSON.stringify(PRO_PLAN)
    expect(everything).not.toMatch(/\$\s*\d/)
    expect(everything).not.toMatch(/\b89\b/)
  })
})

describe('the three cancellation facts (main §14.6, Appendix A)', () => {
  it('are stated verbatim wherever cancellation is offered', () => {
    expect(CANCELLATION_FACTS).toMatchInlineSnapshot(`
      [
        "Your published articles stay on your store.",
        "Generation stops at the end of your billing period.",
        "You keep read access to everything.",
      ]
    `)
  })

  it('are on the plan screen, where the merchant decides to subscribe', () => {
    expect(PRO_PLAN.cancellationFacts).toEqual(CANCELLATION_FACTS)
  })
})

describe('price ids are config (main §4.2)', () => {
  it('resolves each interval to its configured Stripe price', () => {
    const catalog = { monthly: 'price_m', annual: 'price_a' }
    expect(priceIdFor(catalog, 'monthly')).toBe('price_m')
    expect(priceIdFor(catalog, 'annual')).toBe('price_a')
  })

  it('refuses an interval with no configured price rather than guessing', () => {
    expect(() => priceIdFor({ monthly: '', annual: 'price_a' }, 'monthly')).toThrow(
      UnknownBillingInterval,
    )
  })
})

/**
 * ui §2.3 puts a price and a monthly/annual toggle on the plan card; main §4.2
 * says "amounts live in Stripe only — the app never hardcodes a dollar amount".
 * So the screen has to ask Stripe, and `/api/billing/plan` is what it asks.
 */
describe('plan prices come from Stripe and are cached (main §4.2, ui §2.3)', () => {
  const prices = { monthly: 'price_m', annual: 'price_a' }

  function stripeDouble(amounts: Record<string, number>) {
    let calls = 0
    return {
      get calls() {
        return calls
      },
      provider: {
        fetchPrices: async (ids: readonly string[]) => {
          calls += 1
          return ids.map((priceId) => ({
            priceId,
            unitAmountMinor: amounts[priceId] ?? null,
            currency: 'usd',
          }))
        },
      },
    }
  }

  beforeEach(() => clearPlanPriceCache())

  it('reads both amounts from Stripe and never writes one down', async () => {
    const stripe = stripeDouble({ price_m: 8900, price_a: 85440 })
    const plan = await planWithPrices({ stripe: stripe.provider, prices })

    expect(plan.prices).toEqual([
      { interval: 'monthly', priceId: 'price_m', unitAmountMinor: 8900, currency: 'usd' },
      { interval: 'annual', priceId: 'price_a', unitAmountMinor: 85440, currency: 'usd' },
    ])
    // The cap line rides along verbatim (invariant 24).
    expect(plan.capLine).toBe(PLAN_CAP_LINE)
  })

  it('serves the cached amounts rather than asking Stripe on every page view', async () => {
    const stripe = stripeDouble({ price_m: 8900, price_a: 85440 })
    await planWithPrices({ stripe: stripe.provider, prices })
    await planWithPrices({ stripe: stripe.provider, prices })
    expect(stripe.calls).toBe(1)
  })

  it('asks again once the cache has expired', async () => {
    const stripe = stripeDouble({ price_m: 8900, price_a: 85440 })
    let clock = 0
    const deps = { stripe: stripe.provider, prices, now: () => clock }
    await planWithPrices(deps)
    clock += PLAN_PRICE_CACHE_MS + 1
    await planWithPrices(deps)
    expect(stripe.calls).toBe(2)
  })

  it('does not serve the previous plan amounts after a price id changes', async () => {
    const stripe = stripeDouble({ price_m: 8900, price_a: 85440, price_m2: 12900 })
    await planWithPrices({ stripe: stripe.provider, prices })
    const repriced = await planWithPrices({
      stripe: stripe.provider,
      prices: { monthly: 'price_m2', annual: 'price_a' },
    })
    expect(repriced.prices[0]?.unitAmountMinor).toBe(12900)
  })

  it('pauses rather than inventing an amount when Stripe cannot be read', async () => {
    // main §14.4 — degrade to pause, never to something half-right. A wrong
    // price on a purchase screen is worse than no price. Every reason Stripe
    // might be unreadable arrives as the same thing, because the screen has
    // nothing useful to do with the difference.
    await expect(
      planWithPrices({
        stripe: {
          fetchPrices: async () => {
            throw new Error('stripe unreachable')
          },
        },
        prices,
      }),
    ).rejects.toBeInstanceOf(PlanPricesUnavailable)
  })

  it('pauses when Stripe answers without one of the configured prices', async () => {
    const stripe = stripeDouble({ price_m: 8900 })
    await expect(
      planWithPrices({
        stripe: { fetchPrices: async () => [{ priceId: 'price_m', unitAmountMinor: 8900, currency: 'usd' }] },
        prices,
      }),
    ).rejects.toBeInstanceOf(PlanPricesUnavailable)
    expect(stripe.calls).toBe(0)
  })
})

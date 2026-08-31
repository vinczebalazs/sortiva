import { describe, expect, it } from 'vitest'
import { CANCELLATION_FACTS, PLAN_CAP_LINE } from './copy'
import { priceIdFor, PRO_PLAN, UnknownBillingInterval } from './plan'

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

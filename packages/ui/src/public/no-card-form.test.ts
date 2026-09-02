import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RESPONSE_FIXTURES } from '../msw/fixtures'
import { PlanCard } from './PlanCard'
import { PlanUnavailable } from './PlanCard'
import type { PlanResponse } from './plan'

/**
 * We render no card form, ever.
 *
 * Purchase goes to Stripe Checkout and card changes go to Stripe's Customer
 * Portal, both of them pages on Stripe's own domain. The point is not tidiness:
 * a card number that never touches our markup never touches our servers or our
 * logs, which is what keeps the product out of the strictest tier of payment
 * compliance and deletes a whole class of breach with it.
 *
 * That is a promise about the entire repository rather than about one
 * component, so this reads every tracked file rather than the three screens
 * that happen to be about money. It is worth the seconds it costs: a card field
 * would most likely arrive by someone reaching for a payment widget in a hurry,
 * and a test that only watched the plan screen would not see it.
 */

/** Things that only appear when a page is collecting card details. */
const CARD_FORM_MARKERS: readonly (readonly [string, RegExp])[] = [
  ['a browser autofill hint for card fields', /autoComplete\s*=\s*["'{]?\s*["']?cc-|autocomplete\s*=\s*["']cc-/i],
  ['a field named after a card number', /card_?number|numeroCarte|pan_?field/i],
  ['a field named after a card security code', /\bcvc\b|\bcvv\b|security_?code/i],
  ['a field named after a card expiry', /expiry_?(date|month|year)|exp_?month|exp_?year/i],
  ['a card-collecting Stripe widget', /@stripe\/(react-)?stripe-js|CardElement|PaymentElement|elements\(\)\.create/],
  ["Stripe's browser script", /js\.stripe\.com/],
  ['a credit-card field by name', /credit_?card|creditCard/i],
]

/** Text this file cannot scan without matching itself. */
const SELF = 'packages/ui/src/public/no-card-form.test.ts'

/** Prose, not product. The specs describe the rule and must be able to name it. */
const NOT_PRODUCT = /^(docs\/|DECISIONS\.md$|CLAUDE\.md$|README|pnpm-lock\.yaml$)/

function trackedFiles(): string[] {
  const listing = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  return listing
    .split('\n')
    .filter(Boolean)
    .filter((path) => path !== SELF && !NOT_PRODUCT.test(path))
}

describe('no card form anywhere in the product', () => {
  it('has no file collecting card details', () => {
    const offenders: string[] = []

    for (const path of trackedFiles()) {
      let contents: string
      try {
        contents = readFileSync(path, 'utf8')
      } catch {
        // A file listed by git but absent from disk is a concurrent lint proof
        // planting and removing its fixtures, not a card form.
        continue
      }
      for (const [what, pattern] of CARD_FORM_MARKERS) {
        if (pattern.test(contents)) offenders.push(`${path}: ${what}`)
      }
    }

    expect(offenders).toEqual([])
  })

  it('sells the plan with one button that leaves for Stripe, and no field of any kind', () => {
    const plan = RESPONSE_FIXTURES['GET /api/billing/plan'] as PlanResponse
    const html = renderToStaticMarkup(
      createElement(PlanCard, {
        plan,
        interval: 'monthly',
        showCardSafety: true,
        action: createElement('button', { type: 'button' }, 'Subscribe'),
      }),
    )

    expect(html).not.toContain('<input')
    expect(html).not.toContain('<form')
    expect(html).toContain('Payment is handled entirely by Stripe Checkout')
  })

  it('asks for nothing when the price cannot be read either', () => {
    const html = renderToStaticMarkup(createElement(PlanUnavailable, {}))
    expect(html).not.toContain('<input')
    expect(html).not.toContain('<form')
  })
})

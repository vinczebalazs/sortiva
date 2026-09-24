import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * We render no card form, ever.
 *
 * There is no purchase layer at all now, and when billing returns it will be
 * Shopify's own screens. The point is not tidiness: a card number that never
 * touches our markup never touches our servers or our logs, which is what keeps
 * the product out of the strictest tier of payment compliance and deletes a
 * whole class of breach with it. The rule outlives any particular payment
 * vendor, which is why this file checks the whole repository rather than the
 * screens that happen to be about money.
 *
 * It is worth the seconds it costs: a card field would most likely arrive by
 * someone reaching for a payment widget in a hurry, and a test watching one
 * screen would not see it.
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
})

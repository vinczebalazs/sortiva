import type { PriceCatalog, StripeBillingProvider } from '@sortiva/core'
import { StripeProvider } from '@sortiva/providers'

/**
 * main §4.2 — "price IDs are config, amounts live in Stripe only — the app
 * never hardcodes a dollar amount". Repricing is a Stripe change plus a copy
 * change, never a code change.
 *
 * Everything here is read lazily, at the moment a route actually needs it: no
 * Stripe key exists in dev, and a module-level client would fail `next build`.
 */

export class BillingNotConfigured extends Error {
  constructor(missing: string) {
    super(`${missing} is not set; billing routes cannot serve this request.`)
    this.name = 'BillingNotConfigured'
  }
}

export function priceCatalog(): PriceCatalog {
  const monthly = process.env.STRIPE_PRICE_ID_MONTHLY
  const annual = process.env.STRIPE_PRICE_ID_ANNUAL
  if (!monthly) throw new BillingNotConfigured('STRIPE_PRICE_ID_MONTHLY')
  if (!annual) throw new BillingNotConfigured('STRIPE_PRICE_ID_ANNUAL')
  return { monthly, annual }
}

export function appUrl(): string {
  const url = process.env.APP_URL
  if (!url) throw new BillingNotConfigured('APP_URL')
  return url
}

let provider: StripeBillingProvider | undefined

/** The single instrumented Stripe wrapper (invariant 25). Built once per process. */
export function stripeProvider(): StripeBillingProvider {
  provider ??= new StripeProvider()
  return provider
}

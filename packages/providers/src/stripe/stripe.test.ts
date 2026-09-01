import { describe, expect, it } from 'vitest'
import { WebhookSignatureError } from '@sortiva/core'
import { MockStripeProvider } from './mock'

/**
 * The double enforces the two Stripe behaviours our code depends on, so a test
 * written against it is testing the production contract rather than the
 * double's convenience.
 */

describe('MockStripeProvider verifies signatures the way Stripe does', () => {
  it('accepts a body it signed itself', () => {
    const stripe = new MockStripeProvider()
    const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', created: 1_700_000_000 })
    const event = stripe.constructEvent(body, stripe.sign(body))
    expect(event.id).toBe('evt_1')
    expect(event.created).toEqual(new Date(1_700_000_000 * 1000))
  })

  it('rejects a body altered after signing', () => {
    const stripe = new MockStripeProvider()
    const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' })
    const signature = stripe.sign(body)
    expect(() => stripe.constructEvent(`${body} `, signature)).toThrow(WebhookSignatureError)
  })

  it('rejects a body signed with someone else’s secret', () => {
    const attacker = new MockStripeProvider('whsec_attacker')
    const ours = new MockStripeProvider('whsec_ours')
    const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' })
    expect(() => ours.constructEvent(body, attacker.sign(body))).toThrow(WebhookSignatureError)
  })

  it('rejects a missing or malformed header', () => {
    const stripe = new MockStripeProvider()
    expect(() => stripe.constructEvent('{}', null)).toThrow(WebhookSignatureError)
    expect(() => stripe.constructEvent('{}', 'nonsense')).toThrow(WebhookSignatureError)
  })
})

describe('Checkout sessions are idempotent on a derived key (main §14.3.2)', () => {
  const request = {
    accountId: 'acc_1',
    email: 'merchant@example.com',
    priceId: 'price_monthly',
    successUrl: 'https://app.test/dashboard',
    cancelUrl: 'https://app.test/plan',
    idempotencyKey: 'checkout:acc_1:price_monthly',
  }

  it('a double-clicked Subscribe button opens one session, not two', async () => {
    const stripe = new MockStripeProvider()
    const first = await stripe.createCheckoutSession(request)
    const second = await stripe.createCheckoutSession(request)
    expect(second).toEqual(first)
    expect(stripe.checkoutSessions).toHaveLength(1)
  })

  it('a different price is a different session', async () => {
    const stripe = new MockStripeProvider()
    await stripe.createCheckoutSession(request)
    const annual = await stripe.createCheckoutSession({
      ...request,
      priceId: 'price_annual',
      idempotencyKey: 'checkout:acc_1:price_annual',
    })
    expect(annual.sessionId).not.toBe((await stripe.createCheckoutSession(request)).sessionId)
    expect(stripe.checkoutSessions).toHaveLength(2)
  })
})

describe('reading the plan prices', () => {
  it('answers with the prices it has', async () => {
    const stripe = new MockStripeProvider()
    stripe.setPrice({ priceId: 'price_monthly', unitAmountMinor: 8900, currency: 'gbp' })
    stripe.setPrice({ priceId: 'price_annual', unitAmountMinor: 85440, currency: 'gbp' })
    const prices = await stripe.fetchPrices(['price_monthly', 'price_annual'])
    expect(prices).toEqual([
      { priceId: 'price_monthly', unitAmountMinor: 8900, currency: 'gbp' },
      { priceId: 'price_annual', unitAmountMinor: 85440, currency: 'gbp' },
    ])
  })

  it('omits an id Stripe does not have, rather than failing', async () => {
    // Matches the real client. A configured id that does not exist is a
    // configuration mistake, and the caller turns a missing price into a
    // paused plan screen rather than showing half a plan.
    const stripe = new MockStripeProvider()
    stripe.setPrice({ priceId: 'price_monthly', unitAmountMinor: 8900, currency: 'gbp' })
    expect(await stripe.fetchPrices(['price_monthly', 'price_gone'])).toHaveLength(1)
  })

  it('surfaces a Stripe outage rather than reporting no prices', async () => {
    const stripe = new MockStripeProvider()
    stripe.setPrice({ priceId: 'price_monthly', unitAmountMinor: 8900, currency: 'gbp' })
    stripe.failNext(new Error('stripe unreachable'))
    await expect(stripe.fetchPrices(['price_monthly'])).rejects.toThrow('stripe unreachable')
  })
})

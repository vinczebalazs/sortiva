import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PLAN_CAP_LINE, ROUTES } from '@sortiva/core'
import { databaseAvailable, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { MockStripeProvider } from '@sortiva/providers'
import { withAccount } from '../../auth/_lib/session'
import { makeAccountRouteHandler } from '../../account/_lib/handler'
import { makeCheckoutHandler, makePortalHandler } from './handlers'

/**
 * main §4.2, ui §2.3 / §9.4 — the two payment surfaces. Driven end to end: the
 * real `withAccount` wrapper, the real handlers, real repositories, a real
 * Postgres. Only Stripe itself is the double.
 */

const available = await databaseAvailable()

const PRICES = { monthly: 'price_monthly', annual: 'price_annual' }
const APP_URL = 'https://app.sortiva.test'

describe.skipIf(!available)('billing routes (main §4.2)', () => {
  let harness: TestDb
  let accountId: string
  let stripe: MockStripeProvider

  const session = (id: string) => async () => id

  beforeAll(async () => {
    harness = await setupTestDb('web_billing_routes')
  })

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    stripe = new MockStripeProvider()
    const { rows } = await harness.pool.query<{ id: string }>(
      "INSERT INTO accounts (email) VALUES ('merchant@example.com') RETURNING id",
    )
    accountId = rows[0]!.id
  })

  function checkout() {
    return withAccount(
      makeCheckoutHandler({ database: harness.db, stripe, prices: PRICES, appUrl: APP_URL }),
      session(accountId),
    )
  }

  function portal() {
    return withAccount(
      makePortalHandler({ database: harness.db, stripe, appUrl: APP_URL }),
      session(accountId),
    )
  }

  function post(body?: unknown): Request {
    return new Request('https://app.sortiva.test/api/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  it('returns a Stripe-hosted URL and never a card form', async () => {
    const response = await checkout()(post({ interval: 'monthly' }), {})
    expect(response.status).toBe(200)
    const body = (await response.json()) as { url: string }
    expect(body.url).toMatch(/^https:\/\/checkout\.stripe\.test\//)

    const request = stripe.checkoutSessions[0]!
    expect(request.priceId).toBe(PRICES.monthly)
    // How the webhook finds the account (main §4.2 "attach customer … to account").
    expect(request.accountId).toBe(accountId)
    expect(request.successUrl.startsWith(APP_URL)).toBe(true)
  })

  it('honours the annual price', async () => {
    await checkout()(post({ interval: 'annual' }), {})
    expect(stripe.checkoutSessions[0]!.priceId).toBe(PRICES.annual)
  })

  it('opens one session for a double-clicked Subscribe button (main §14.3.2)', async () => {
    const first = await (await checkout()(post({ interval: 'monthly' }), {})).json()
    const second = await (await checkout()(post({ interval: 'monthly' }), {})).json()
    expect(second).toEqual(first)
    expect(stripe.checkoutSessions).toHaveLength(1)
  })

  it('rejects an interval the plan does not offer', async () => {
    const response = await checkout()(post({ interval: 'weekly' }), {})
    expect(response.status).toBe(422)
    expect(stripe.checkoutSessions).toHaveLength(0)
  })

  it('reuses the Stripe customer once the account has one', async () => {
    await harness.pool.query('UPDATE accounts SET stripe_customer_id = $1 WHERE id = $2', [
      'cus_existing',
      accountId,
    ])
    await checkout()(post({ interval: 'monthly' }), {})
    expect(stripe.checkoutSessions[0]!.customerId).toBe('cus_existing')
  })

  it('needs a session — an anonymous request cannot start a purchase', async () => {
    const anonymous = withAccount(
      makeCheckoutHandler({ database: harness.db, stripe, prices: PRICES, appUrl: APP_URL }),
      async () => null,
    )
    const response = await anonymous(post({ interval: 'monthly' }), {})
    expect(response.status).toBe(401)
  })

  it('sends a subscribed merchant to the Customer Portal', async () => {
    await harness.pool.query('UPDATE accounts SET stripe_customer_id = $1 WHERE id = $2', [
      'cus_existing',
      accountId,
    ])
    const response = await portal()(post(), {})
    expect(response.status).toBe(200)
    expect(stripe.portalSessions[0]!.customerId).toBe('cus_existing')
  })

  it('has no Portal to open before the first Checkout', async () => {
    const response = await portal()(post(), {})
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe('billing_not_set_up')
  })
})

describe.skipIf(!available)('read access is never revoked by billing state (invariant 16)', () => {
  let harness: TestDb

  beforeAll(async () => {
    harness = await setupTestDb('web_billing_read_access')
  })

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
  })

  /** main §14.6 — a cancelled account keeps read access to everything, indefinitely. */
  const deadStates = ['canceled', 'past_due', 'incomplete_expired'] as const

  for (const status of deadStates) {
    it(`GET /api/account is 200 for a ${status} account`, async () => {
      const { rows } = await harness.pool.query<{ id: string }>(
        `INSERT INTO accounts (email) VALUES ('${status}@example.com') RETURNING id`,
      )
      const accountId = rows[0]!.id
      await harness.pool.query(
        `INSERT INTO subscriptions (account_id, stripe_subscription_id, price_id, status)
         VALUES ($1, $2, 'price_monthly', $3::subscription_status)`,
        [accountId, `sub_${status}`, status],
      )

      const handler = withAccount(makeAccountRouteHandler(harness.db), async () => accountId)
      const response = await handler(new Request('https://app.sortiva.test/api/account'), {})

      expect(response.status).toBe(200)
      const body = (await response.json()) as { subscription: { status: string } }
      expect(body.subscription.status).toBe(status)
    })
  }

  it('no GET route in the frozen table is gated on entitlement', () => {
    const gatedReads = ROUTES.filter((r) => r.method === 'GET' && r.requiresEntitlement)
    expect(gatedReads.map((r) => r.path)).toEqual([])
  })

  it('neither payment surface is gated on entitlement — a past_due account must reach the Portal', () => {
    const billing = ROUTES.filter((r) => r.path.startsWith('/api/billing/'))
    expect(billing.length).toBeGreaterThan(0)
    expect(billing.filter((r) => r.requiresEntitlement)).toEqual([])
  })

  it('the plan screen still states the cap verbatim (invariant 24)', () => {
    expect(PLAN_CAP_LINE).toBe('Up to 1 article per day, quality permitting')
  })
})

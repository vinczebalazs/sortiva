import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  DOMAIN_CLAIMED_EVENT,
  drainStripeEvents,
  provisionAccount,
  SIGNUP_COMPLETED_EVENT,
  type RemoteSubscription,
} from '@sortiva/core'
import { stripeEventFixtures } from '@sortiva/core/billing/testing'
import { databaseAvailable, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { dispatchableSteps } from '@sortiva/jobs/runtime/steps'
import { MockPosthogCapture, MockStripeProvider } from '@sortiva/providers'
import { makeAccountRouteHandler } from '../../account/_lib/handler'
import { makeDbAccountStore } from '../../auth/_lib/provisioning'
import { withAccount } from '../../auth/_lib/session'
import { makeCheckoutHandler } from '../../billing/_lib/handlers'
import { billingWorkerDeps, handleStripeWebhook } from '../../webhooks/stripe/_lib/receiver'
import { makeClaimHandler } from './handler'
import { makeDomainClaimStore } from './store'

/**
 * **The M1 exit gate.** One merchant walks the whole funnel — sign up, pay,
 * connect a domain, land on the progress state — through the real route
 * handlers, the real session wrapper, the real repositories and a real
 * Postgres. Only Stripe and PostHog are doubles.
 *
 * It is not the browser test the card asks for: no screen exists to drive
 * (Lane F has not started, `packages/ui` holds only the M0 mock server). This
 * is the highest level that genuinely exists today — every HTTP contract the
 * screens will call, in order, against real state. See DECISIONS 2026-09-01
 * T1.4 and the T1.4 report.
 */

const available = await databaseAvailable()

const CUSTOMER = 'cus_funnel'
const SUBSCRIPTION = 'sub_funnel'
const PRICES = { monthly: 'price_monthly', annual: 'price_annual' }
const APP_URL = 'https://app.sortiva.test'

describe.skipIf(!available)('M1 funnel: signup → plan → claim → progress', () => {
  let harness: TestDb
  let capture: MockPosthogCapture
  let stripe: MockStripeProvider

  beforeAll(async () => {
    harness = await setupTestDb('web_m1_funnel')
  })

  afterAll(async () => {
    await harness.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    capture = new MockPosthogCapture()
    stripe = new MockStripeProvider()
    stripe.setSubscription({
      subscriptionId: SUBSCRIPTION,
      customerId: CUSTOMER,
      status: 'active',
      priceId: PRICES.monthly,
      currentPeriodEnd: new Date('2026-10-01T00:00:00Z'),
      cancelAtPeriodEnd: false,
    } satisfies RemoteSubscription)
  })

  const session = (id: string) => async () => id

  it('walks a merchant from nothing to an ingesting domain', async () => {
    // ── 1. Signup (main §4.1) ────────────────────────────────────────────────
    const { accountId, created } = await provisionAccount(
      { store: makeDbAccountStore(harness.db), capture },
      { email: 'merchant@example.com', provider: 'google' },
    )
    expect(created).toBe(true)
    expect(capture.of(SIGNUP_COMPLETED_EVENT)).toHaveLength(1)

    // main §4.3 — auth is not a connected domain: the dashboard's empty state.
    const account = () => withAccount(makeAccountRouteHandler(harness.db), session(accountId))
    const afterSignup = await (await account()(get('/api/account'), undefined)).json()
    expect(afterSignup.domain).toBeNull()
    expect(afterSignup.subscription.status).toBe('none')

    // ── 2. Plan → Stripe Checkout (main §4.2, ui §2.3) ───────────────────────
    const checkout = withAccount(
      makeCheckoutHandler({ database: harness.db, stripe, prices: PRICES, appUrl: APP_URL }),
      session(accountId),
    )
    const checkoutResponse = await checkout(
      new Request(`${APP_URL}/api/billing/checkout`, {
        method: 'POST',
        body: JSON.stringify({ interval: 'monthly' }),
      }),
      undefined,
    )
    expect(checkoutResponse.status).toBe(200)
    expect((await checkoutResponse.json()).url).toContain('http')

    // Stripe pays and tells us over the webhook; entitlement is our local row,
    // never a Stripe call in a request path (invariant 16).
    const fixtures = stripeEventFixtures({
      accountId,
      customerId: CUSTOMER,
      subscriptionId: SUBSCRIPTION,
      priceId: PRICES.monthly,
    })
    await deliver(fixtures.checkoutCompleted('evt_1', 1_700_000_000))
    await deliver(fixtures.subscriptionUpdated('evt_2', 1_700_000_100, { status: 'active' }))
    await drainStripeEvents(billingWorkerDeps({ database: harness.db, pool: harness.pool, stripe }))

    const afterPayment = await (await account()(get('/api/account'), undefined)).json()
    expect(afterPayment.subscription.status).toBe('active')
    expect(afterPayment.domain).toBeNull()

    // ── 3. Claim the domain (main §5, ui §3.1) ───────────────────────────────
    const claim = withAccount(
      makeClaimHandler({
        deps: { store: makeDomainClaimStore({ database: harness.db }), capture },
      }),
      session(accountId),
    )
    const claimResponse = await claim(
      new Request(`${APP_URL}/api/domain/claim`, {
        method: 'POST',
        body: JSON.stringify({ domain: 'https://www.Acme-Supply.co.uk/collections/all' }),
      }),
      undefined,
    )
    expect(claimResponse.status).toBe(200)
    const claimed = await claimResponse.json()
    expect(claimed.normalized).toBe('acme-supply.co.uk')
    expect(capture.of(DOMAIN_CLAIMED_EVENT)).toHaveLength(1)

    // ── 4. The progress state (main §5 step 3, ui §3.2) ──────────────────────
    // What the dashboard reads to stop rendering "Connect your domain" and
    // start rendering the ingestion stepper.
    const afterClaim = await (await account()(get('/api/account'), undefined)).json()
    expect(afterClaim.domain).toEqual({
      normalized: 'acme-supply.co.uk',
      state: 'ingesting',
      platform: null,
    })
    expect(afterClaim.subscription.status).toBe('active')

    // And what the stepper's steps come from: a durable run whose first step is
    // waiting for a worker, with every later step pending behind it (ui §3.2's
    // seven-step stepper, main §14.3.1's dependency gating).
    const steps = await harness.pool.query<{ step: string; state: string }>(
      'SELECT step, state FROM job_steps WHERE job_id = $1',
      [claimed.ingestionJobId],
    )
    expect(steps.rows.every((row) => row.state === 'pending')).toBe(true)
    expect(steps.rows.map((row) => row.step)).toContain('detect')

    const dispatchable = await dispatchableSteps(harness.db, claimed.ingestionJobId)
    expect(dispatchable.map((step) => step.step)).toEqual(['detect'])
  })

  function get(path: string): Request {
    return new Request(`${APP_URL}${path}`)
  }

  async function deliver(event: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify(event)
    const response = await handleStripeWebhook(
      new Request(`${APP_URL}/api/webhooks/stripe`, {
        method: 'POST',
        headers: { 'stripe-signature': stripe.sign(body) },
        body,
      }),
      { database: harness.db, pool: harness.pool, stripe, drain: false },
    )
    expect(response.status).toBe(200)
  }
})

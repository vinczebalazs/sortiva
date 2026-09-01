import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { billingGate, drainStripeEvents, reconcileSubscriptions } from '@sortiva/core'
import type { RemoteSubscription } from '@sortiva/core'
// Test surface, deliberately not part of `@sortiva/core`'s public index.
import { stripeEventFixtures } from '@sortiva/core/billing/testing'
import { databaseAvailable, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { MockStripeProvider } from '@sortiva/providers'
import { makeBillingStore } from '../../../billing/_lib/store'
import { billingWorkerDeps, handleStripeWebhook } from './receiver'

/**
 * tech §3 — the receiver verifies, stores and answers; the status worker
 * decides. This drives the whole chain against real SQL, because the ordering
 * guard that makes an out-of-order webhook safe is a `WHERE` clause, and a
 * `WHERE` clause asserted in TypeScript is not a guard.
 */

const available = await databaseAvailable()

const CUSTOMER = 'cus_int_1'
const SUBSCRIPTION = 'sub_int_1'
const PRICE = 'price_monthly'

describe.skipIf(!available)('POST /api/webhooks/stripe (main §4.2, §14.3.8)', () => {
  let harness: TestDb
  let stripe: MockStripeProvider
  let accountId: string
  let fixtures: ReturnType<typeof stripeEventFixtures>

  beforeAll(async () => {
    harness = await setupTestDb('web_stripe_webhook')
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
    fixtures = stripeEventFixtures({
      accountId,
      customerId: CUSTOMER,
      subscriptionId: SUBSCRIPTION,
      priceId: PRICE,
    })
    stripe.setSubscription(remote('active'))
  })

  function remote(status: RemoteSubscription['status']): RemoteSubscription {
    return {
      subscriptionId: SUBSCRIPTION,
      customerId: CUSTOMER,
      status,
      priceId: PRICE,
      currentPeriodEnd: new Date('2026-10-01T00:00:00Z'),
      cancelAtPeriodEnd: false,
    }
  }

  function deps() {
    return billingWorkerDeps({ database: harness.db, pool: harness.pool, stripe })
  }

  /** Posts a signed event exactly as Stripe would, with no drain. */
  async function post(event: Record<string, unknown>, signature?: string): Promise<Response> {
    const body = JSON.stringify(event)
    return handleStripeWebhook(
      new Request('https://app.sortiva.test/api/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': signature ?? stripe.sign(body) },
        body,
      }),
      { database: harness.db, pool: harness.pool, stripe, drain: false },
    )
  }

  async function deliver(events: readonly Record<string, unknown>[]): Promise<void> {
    for (const event of events) expect((await post(event)).status).toBe(200)
    await drainStripeEvents(deps())
  }

  async function storedStatus(): Promise<string | null> {
    const { rows } = await harness.pool.query<{ status: string }>(
      'SELECT status FROM subscriptions WHERE account_id = $1',
      [accountId],
    )
    return rows[0]?.status ?? null
  }

  it('refuses a forged payload before it reaches the store', async () => {
    const response = await post(fixtures.checkoutCompleted('evt_forged', 1_000), 't=1,v1=deadbeef')
    expect(response.status).toBe(400)
    const { rows } = await harness.pool.query('SELECT 1 FROM stripe_events')
    expect(rows).toHaveLength(0)
  })

  it('stores a verified event and answers 200 immediately', async () => {
    const response = await post(fixtures.checkoutCompleted('evt_1', 1_000))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ received: true })

    const { rows } = await harness.pool.query<{ event_id: string; processed_at: string | null }>(
      'SELECT event_id, processed_at FROM stripe_events',
    )
    expect(rows).toHaveLength(1)
    // Nothing is decided inside the request: processing is what marks it.
    expect(rows[0]!.processed_at).toBeNull()
  })

  it('deduplicates Stripe’s at-least-once redelivery on the event id', async () => {
    const event = fixtures.checkoutCompleted('evt_1', 1_000)
    expect((await post(event)).status).toBe(200)
    expect((await post(event)).status).toBe(200)
    const { rows } = await harness.pool.query('SELECT 1 FROM stripe_events')
    expect(rows).toHaveLength(1)
  })

  it('activate: Checkout attaches the customer and writes the first row', async () => {
    await deliver([fixtures.checkoutCompleted('evt_1', 1_000)])

    expect(await storedStatus()).toBe('active')
    const { rows } = await harness.pool.query<{ stripe_customer_id: string }>(
      'SELECT stripe_customer_id FROM accounts WHERE id = $1',
      [accountId],
    )
    expect(rows[0]!.stripe_customer_id).toBe(CUSTOMER)

    const gate = billingGate(await makeBillingStore({ database: harness.db }).readSubscription(accountId))
    expect(gate.generationAllowed).toBe(true)
  })

  it('payment_failed → past_due → paid drives the stored status', async () => {
    await deliver([fixtures.checkoutCompleted('evt_1', 1_000)])

    // A subscription event is a signal to re-read, so what Stripe holds is what
    // gets stored — set it before delivering, exactly as Stripe would.
    stripe.setSubscription(remote('past_due'))
    await deliver([
      fixtures.invoicePaymentFailed('evt_2', 2_000),
      fixtures.subscriptionUpdated('evt_3', 2_001, { status: 'past_due' }),
    ])
    expect(await storedStatus()).toBe('past_due')

    stripe.setSubscription(remote('active'))
    await deliver([
      fixtures.invoicePaid('evt_4', 3_000),
      fixtures.subscriptionUpdated('evt_5', 3_001, { status: 'active' }),
    ])
    expect(await storedStatus()).toBe('active')
  })

  it('cancel_at_period_end keeps entitlement until the period actually ends', async () => {
    await deliver([fixtures.checkoutCompleted('evt_1', 1_000)])
    stripe.setSubscription({ ...remote('active'), cancelAtPeriodEnd: true })
    await deliver([
      fixtures.subscriptionUpdated('evt_6', 4_000, { status: 'active', cancelAtPeriodEnd: true }),
    ])

    const { rows } = await harness.pool.query<{ status: string; cancel_at_period_end: boolean }>(
      'SELECT status, cancel_at_period_end FROM subscriptions WHERE account_id = $1',
      [accountId],
    )
    expect(rows[0]).toMatchObject({ status: 'active', cancel_at_period_end: true })

    stripe.setSubscription(remote('canceled'))
    await deliver([fixtures.subscriptionDeleted('evt_7', 5_000)])
    expect(await storedStatus()).toBe('canceled')
  })

  it('a late event lands on what Stripe currently holds, not on its own payload', async () => {
    await deliver([fixtures.checkoutCompleted('evt_1', 1_000)])
    stripe.setSubscription(remote('canceled'))
    await deliver([fixtures.subscriptionUpdated('evt_8', 6_000, { status: 'canceled' })])
    expect(await storedStatus()).toBe('canceled')

    // The `active` update Stripe generated *before* the cancellation, arriving
    // after it. Its payload says active; Stripe says canceled. Since card T1.2a
    // the payload is never written — the event only triggers a re-read — so the
    // cancellation stands.
    await deliver([fixtures.subscriptionUpdated('evt_9', 5_000, { status: 'active' })])
    expect(await storedStatus()).toBe('canceled')
  })

  it('two events stamped in the same second cannot decide the status between them', async () => {
    // The T1.2 audit's finding: Stripe stamps to the second and fires several
    // events per subscription inside one second, and the old rule broke the tie
    // on the alphabetical order of a random Stripe event id. Landing on a stale
    // "not active" locked out a merchant who had just paid, for up to 24h.
    await deliver([fixtures.checkoutCompleted('evt_1', 1_000)])
    stripe.setSubscription(remote('active'))

    const SAME_SECOND = 7_000
    await deliver([
      fixtures.subscriptionUpdated('evt_aaa', SAME_SECOND, { status: 'past_due' }),
      fixtures.subscriptionUpdated('evt_zzz', SAME_SECOND, { status: 'active' }),
    ])
    expect(await storedStatus()).toBe('active')

    // ...and with the ids the other way round, which is the ordering that
    // produced the wrong answer under the old rule.
    await deliver([
      fixtures.subscriptionUpdated('evt_zzz2', SAME_SECOND, { status: 'active' }),
      fixtures.subscriptionUpdated('evt_aaa2', SAME_SECOND, { status: 'past_due' }),
    ])
    expect(await storedStatus()).toBe('active')
  })

  it('reprocessing every stored event changes nothing (effectively-once)', async () => {
    stripe.setSubscription(remote('past_due'))
    await deliver([
      fixtures.checkoutCompleted('evt_1', 1_000),
      fixtures.subscriptionUpdated('evt_3', 2_001, { status: 'past_due' }),
    ])
    const before = await harness.pool.query(
      'SELECT status, cancel_at_period_end FROM subscriptions WHERE account_id = $1',
      [accountId],
    )

    await harness.pool.query('UPDATE stripe_events SET processed_at = NULL')
    await drainStripeEvents(deps())

    const after = await harness.pool.query(
      'SELECT status, cancel_at_period_end FROM subscriptions WHERE account_id = $1',
      [accountId],
    )
    // The state is unchanged. The two timestamps are deliberately excluded:
    // a reprocess does re-read Stripe, so both legitimately advance — that is
    // the row recording a fresh contact, not a state change.
    expect(after.rows).toEqual(before.rows)
  })

  /**
   * The paid-but-unentitled case, against real SQL. Stripe answers "no such
   * subscription" for every object belonging to the other mode, so a
   * live-key/test-key mismatch puts every new subscriber here.
   */
  it('a subscription Stripe cannot find leaves the event open and the orphan visible', async () => {
    // Stripe holds no such object — what a wrong-mode API key looks like.
    stripe.removeSubscription(SUBSCRIPTION)
    await deliver([fixtures.checkoutCompleted('evt_1', 1_000)])

    expect(await storedStatus()).toBeFalsy()
    const open = await harness.pool.query<{ event_id: string }>(
      'SELECT event_id FROM stripe_events WHERE processed_at IS NULL',
    )
    expect(open.rows.map((r) => r.event_id)).toEqual(['evt_1'])

    // The nightly sweep can now see the account, which it could not before:
    // there is no subscription row for the staleness scan to find.
    const store = makeBillingStore({ database: harness.db })
    expect(await store.orphanedCustomers(10)).toEqual([{ accountId, stripeCustomerId: CUSTOMER }])

    // And it repairs itself once the key is right.
    stripe.setSubscription(remote('active'))
    await drainStripeEvents(deps())
    expect(await storedStatus()).toBe('active')
  })

  it('the nightly sweep repairs a status a dropped webhook never delivered', async () => {
    await deliver([fixtures.checkoutCompleted('evt_1', 1_000)])
    expect(await storedStatus()).toBe('active')

    // Stripe moved on; the webhook never arrived. Age the row past the window.
    stripe.setSubscription(remote('past_due'))
    await harness.pool.query("UPDATE subscriptions SET synced_at = now() - interval '48 hours'")

    const report = await reconcileSubscriptions(deps())
    expect(report.repaired).toBe(1)
    expect(await storedStatus()).toBe('past_due')
  })

  /**
   * `claimUnprocessed` is a plain select that claims nothing, so two webhooks
   * arriving milliseconds apart start two drains over the same rows. Since a
   * subscription event now costs a Stripe read, an overlap doubles our Stripe
   * calls and double-counts the §14.7 funnel captures.
   */
  it('only one drain runs at a time', async () => {
    await post(fixtures.checkoutCompleted('evt_1', 1_000))
    await post(fixtures.subscriptionUpdated('evt_2', 2_000, { status: 'active' }))

    const both = await Promise.all([drainStripeEvents(deps()), drainStripeEvents(deps())])
    const processed = both.map((outcomes) => outcomes.length)

    // One drain does the work; the other finds the lock held and returns empty
    // rather than queueing behind it.
    expect(processed.filter((n) => n === 0)).toHaveLength(1)
    expect(processed.reduce((a, b) => a + b, 0)).toBe(2)
    expect(await storedStatus()).toBe('active')
  })

  it('the lock is released, so the next drain still runs', async () => {
    await post(fixtures.checkoutCompleted('evt_1', 1_000))
    await drainStripeEvents(deps())

    await post(fixtures.subscriptionUpdated('evt_2', 2_000, { status: 'active' }))
    const second = await drainStripeEvents(deps())
    expect(second).toHaveLength(1)
  })
})

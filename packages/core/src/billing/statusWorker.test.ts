import { beforeEach, describe, expect, it } from 'vitest'
import { StubNotificationEmitter } from '../contracts/doubles'
import type { AnalyticsEvent } from '../contracts/analytics'
import { billingGate } from './entitlement'
import { drainStripeEvents, type BillingWorkerDeps } from './processing'
import { InMemoryBillingStore, InMemoryStripeEventStore, stripeEventFixtures } from './testing'
import type { RemoteSubscription } from './provider'

/**
 * T1.2's done-when names three Stripe **test-clock** scenarios. A test clock is
 * a live Stripe API feature and needs credentials this build has none of, so
 * what is proven here is the half that lives in our code: the exact webhook
 * sequences those scenarios emit, replayed through the receiver's event store
 * and the status worker **in order, in the wrong order, and twice**, drive the
 * stored status correctly.
 *
 * What is therefore NOT proven: that Stripe emits these sequences with these
 * payloads. That is the outstanding half — see DECISIONS 2026-08-31 T1.2.
 */

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const CUSTOMER = 'cus_test_1'
const SUBSCRIPTION = 'sub_test_1'
const PRICE = 'price_monthly'

const fixtures = stripeEventFixtures({
  accountId: ACCOUNT,
  customerId: CUSTOMER,
  subscriptionId: SUBSCRIPTION,
  priceId: PRICE,
})

const remoteActive: RemoteSubscription = {
  subscriptionId: SUBSCRIPTION,
  customerId: CUSTOMER,
  status: 'active',
  priceId: PRICE,
  currentPeriodEnd: new Date('2026-10-01T00:00:00Z'),
  cancelAtPeriodEnd: false,
}

interface Harness {
  deps: BillingWorkerDeps
  billing: InMemoryBillingStore
  events: InMemoryStripeEventStore
  notifications: StubNotificationEmitter
  capture: { events: AnalyticsEvent[] }
}

function harness(): Harness {
  const billing = new InMemoryBillingStore()
  billing.seedAccount(ACCOUNT, CUSTOMER)
  const events = new InMemoryStripeEventStore()
  const notifications = new StubNotificationEmitter()
  const events_: AnalyticsEvent[] = []
  const capture = { events: events_, capture: (e: AnalyticsEvent) => void events_.push(e) }
  return {
    billing,
    events,
    notifications,
    capture,
    deps: {
      billing,
      events,
      stripe: { fetchSubscription: async () => remoteActive },
      notifications,
      capture,
    },
  }
}

async function record(h: Harness, event: Record<string, unknown>): Promise<void> {
  await h.events.record({
    eventId: String(event['id']),
    type: String(event['type']),
    payload: event,
  })
}

/** Stores a batch, then drains once — the burst case. */
async function deliver(h: Harness, batch: readonly Record<string, unknown>[]): Promise<void> {
  for (const event of batch) await record(h, event)
  await drainStripeEvents(h.deps)
}

/**
 * Stores and processes one event at a time, so the worker really does see them
 * in this order. Draining a stored batch would re-sort by Stripe's `created`
 * and quietly repair the ordering the test is trying to break.
 */
async function deliverOneByOne(
  h: Harness,
  batch: readonly Record<string, unknown>[],
): Promise<void> {
  for (const event of batch) {
    await record(h, event)
    await drainStripeEvents(h.deps)
  }
}

function status(h: Harness) {
  return h.billing.rows.get(ACCOUNT)
}

// The three scenarios, as event sequences. `created` is Stripe's own clock.
const ACTIVATE = [fixtures.checkoutCompleted('evt_1', 1_000)]

const DUNNING = [
  fixtures.invoicePaymentFailed('evt_2', 2_000),
  fixtures.subscriptionUpdated('evt_3', 2_001, { status: 'past_due' }),
]

const RECOVERY = [
  fixtures.invoicePaid('evt_4', 3_000),
  fixtures.subscriptionUpdated('evt_5', 3_001, { status: 'active' }),
]

const CANCEL_AT_PERIOD_END = [
  fixtures.subscriptionUpdated('evt_6', 4_000, { status: 'active', cancelAtPeriodEnd: true }),
]

const PERIOD_ENDED = [fixtures.subscriptionDeleted('evt_7', 5_000)]

describe('the status worker is the single writer of subscriptions.status (main §4.2)', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('activate: Checkout attaches the customer and writes the first row', async () => {
    await deliver(h, ACTIVATE)
    expect(status(h)?.status).toBe('active')
    expect(await h.billing.findAccountIdByCustomerId(CUSTOMER)).toBe(ACCOUNT)
    expect(billingGate(await h.billing.readSubscription(ACCOUNT)).generationAllowed).toBe(true)
    expect(h.capture.events.map((e) => e.event)).toContain('subscription_activated')
  })

  it('payment_failed → past_due → paid: generation stops, then resumes', async () => {
    await deliver(h, ACTIVATE)
    await deliver(h, DUNNING)

    expect(status(h)?.status).toBe('past_due')
    const paused = billingGate(await h.billing.readSubscription(ACCOUNT))
    expect(paused.generationAllowed).toBe(false)
    expect(paused.publishingAllowed).toBe(false)
    // Invariant 16 — reads survive a failed payment.
    expect(paused.readAllowed).toBe(true)
    expect(paused.banner.kind).toBe('payment_failed')
    expect(h.notifications.emitted.filter((n) => n.type === 'payment_failed')).toHaveLength(1)

    await deliver(h, RECOVERY)
    expect(status(h)?.status).toBe('active')
    expect(billingGate(await h.billing.readSubscription(ACCOUNT)).generationAllowed).toBe(true)
  })

  it('an invoice never writes the status — only the subscription events do', async () => {
    await deliver(h, ACTIVATE)
    await deliver(h, [fixtures.invoicePaymentFailed('evt_solo', 2_500)])
    expect(status(h)?.status).toBe('active')
  })

  it('cancel_at_period_end: entitled to period end, then generation stops for good', async () => {
    await deliver(h, ACTIVATE)
    await deliver(h, CANCEL_AT_PERIOD_END)

    const ending = billingGate(await h.billing.readSubscription(ACCOUNT))
    expect(status(h)?.status).toBe('active')
    expect(ending.generationAllowed).toBe(true)
    expect(ending.banner.kind).toBe('ending')

    await deliver(h, PERIOD_ENDED)
    const ended = billingGate(await h.billing.readSubscription(ACCOUNT))
    expect(status(h)?.status).toBe('canceled')
    expect(ended.generationAllowed).toBe(false)
    expect(ended.publishingAllowed).toBe(false)
    // main §14.6 — "the account keeps read access to its articles, calendar
    // history, and GSC reporting", indefinitely.
    expect(ended.readAllowed).toBe(true)
    expect(h.capture.events.map((e) => e.event)).toContain('subscription_canceled')
  })
})

describe('order and repetition cannot change where the account lands', () => {
  const scenarios: { name: string; batch: readonly Record<string, unknown>[]; expected: string }[] =
    [
      { name: 'activate', batch: ACTIVATE, expected: 'active' },
      { name: 'dunning', batch: [...ACTIVATE, ...DUNNING], expected: 'past_due' },
      { name: 'recovery', batch: [...ACTIVATE, ...DUNNING, ...RECOVERY], expected: 'active' },
      {
        name: 'cancellation',
        batch: [...ACTIVATE, ...CANCEL_AT_PERIOD_END, ...PERIOD_ENDED],
        expected: 'canceled',
      },
    ]

  for (const scenario of scenarios) {
    it(`${scenario.name}: in order`, async () => {
      const h = harness()
      await deliver(h, scenario.batch)
      expect(status(h)?.status).toBe(scenario.expected)
    })

    it(`${scenario.name}: processed newest-first still lands on the newest state`, async () => {
      const h = harness()
      // Stripe's at-least-once delivery has no ordering guarantee. The write
      // guard is what makes a late arrival a no-op instead of a rollback.
      await deliverOneByOne(h, [...scenario.batch].reverse())
      expect(status(h)?.status).toBe(scenario.expected)
    })

    it(`${scenario.name}: shuffled delivery lands on the newest state`, async () => {
      const h = harness()
      const shuffled = [...scenario.batch]
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = (i * 7 + 3) % (i + 1)
        ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
      }
      await deliverOneByOne(h, shuffled)
      expect(status(h)?.status).toBe(scenario.expected)
    })

    it(`${scenario.name}: every event delivered twice changes nothing`, async () => {
      const h = harness()
      await deliver(h, scenario.batch)
      const first = { ...status(h) }

      // A redelivery of the same event ids: the store dedupes, and the already
      // processed rows are not drained again.
      await deliver(h, scenario.batch)
      expect({ ...status(h) }).toEqual(first)

      // And a genuine reprocessing of the same payloads — the crash-after-write,
      // before-mark case — is equally inert.
      h.events.processed.clear()
      await drainStripeEvents(h.deps)
      expect({ ...status(h) }).toEqual(first)
    })
  }

  it('one dunning episode sends one payment-failed email however often it is replayed', async () => {
    const h = harness()
    await deliver(h, [...ACTIVATE, ...DUNNING])
    await deliver(h, DUNNING)
    h.events.processed.clear()
    await drainStripeEvents(h.deps)
    expect(h.notifications.emitted.filter((n) => n.type === 'payment_failed')).toHaveLength(1)
  })
})

describe('events that name nothing we hold', () => {
  it('ignores a type main §4.2 does not list', async () => {
    const h = harness()
    await deliver(h, [{ id: 'evt_x', type: 'customer.created', created: 10, data: { object: {} } }])
    expect(status(h)).toBeUndefined()
  })

  it('does not write for an unknown Stripe customer', async () => {
    const h = harness()
    await deliver(h, [
      {
        id: 'evt_y',
        type: 'customer.subscription.updated',
        created: 10,
        data: {
          object: { id: 'sub_other', customer: 'cus_stranger', status: 'active', items: { data: [] } },
        },
      },
    ])
    expect(status(h)).toBeUndefined()
  })
})

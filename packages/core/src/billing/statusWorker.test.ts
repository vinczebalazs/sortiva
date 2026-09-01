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

/**
 * What Stripe currently holds. Since card T1.2a every `customer.subscription.*`
 * event is a *signal to re-read*, so this — not the event payload — decides the
 * stored status. The double models Stripe rather than replaying one fixed
 * answer, because a fixed answer would make the ordering tests below prove
 * nothing.
 */
function remote(fields: Partial<RemoteSubscription> = {}): RemoteSubscription {
  return {
    subscriptionId: SUBSCRIPTION,
    customerId: CUSTOMER,
    status: 'active',
    priceId: PRICE,
    currentPeriodEnd: new Date('2026-10-01T00:00:00Z'),
    cancelAtPeriodEnd: false,
    ...fields,
  }
}

interface Harness {
  deps: BillingWorkerDeps
  billing: InMemoryBillingStore
  events: InMemoryStripeEventStore
  notifications: StubNotificationEmitter
  capture: { events: AnalyticsEvent[] }
  /** Mutable: set it to what Stripe would answer, then deliver the event. */
  stripe: { current: RemoteSubscription | null; reads: number }
}

function harness(): Harness {
  const billing = new InMemoryBillingStore()
  billing.seedAccount(ACCOUNT, CUSTOMER)
  const events = new InMemoryStripeEventStore()
  const notifications = new StubNotificationEmitter()
  const events_: AnalyticsEvent[] = []
  const capture = { events: events_, capture: (e: AnalyticsEvent) => void events_.push(e) }
  const stripe = { current: remote() as RemoteSubscription | null, reads: 0 }
  // Every write is stamped with the moment of its Stripe read, so the clock has
  // to advance between reads: two reads landing on the same millisecond would
  // tie, and the guard's `<=` would let the later one through by luck rather
  // than by rule.
  let tick = 0
  return {
    billing,
    events,
    notifications,
    capture,
    stripe,
    deps: {
      billing,
      events,
      stripe: {
        fetchSubscription: async (id: string) => {
          stripe.reads += 1
          return id === SUBSCRIPTION ? stripe.current : null
        },
      },
      notifications,
      capture,
      now: () => new Date(1_000_000 + (tick += 1000)),
    },
  }
}

/** Sets what Stripe would answer for the subscription under test. */
function stripeHolds(h: Harness, fields: Partial<RemoteSubscription>): void {
  h.stripe.current = remote(fields)
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
//
// Each batch is paired with the state Stripe holds by the time we process it,
// because that — not the payload — is now what the worker writes.
const ACTIVATE = [fixtures.checkoutCompleted('evt_1', 1_000)]
const ACTIVATE_REMOTE: Partial<RemoteSubscription> = { status: 'active' }

const DUNNING = [
  fixtures.invoicePaymentFailed('evt_2', 2_000),
  fixtures.subscriptionUpdated('evt_3', 2_001, { status: 'past_due' }),
]
const DUNNING_REMOTE: Partial<RemoteSubscription> = { status: 'past_due' }

const RECOVERY = [
  fixtures.invoicePaid('evt_4', 3_000),
  fixtures.subscriptionUpdated('evt_5', 3_001, { status: 'active' }),
]
const RECOVERY_REMOTE: Partial<RemoteSubscription> = { status: 'active' }

const CANCEL_AT_PERIOD_END = [
  fixtures.subscriptionUpdated('evt_6', 4_000, { status: 'active', cancelAtPeriodEnd: true }),
]
const CANCEL_AT_PERIOD_END_REMOTE: Partial<RemoteSubscription> = {
  status: 'active',
  cancelAtPeriodEnd: true,
}

const PERIOD_ENDED = [fixtures.subscriptionDeleted('evt_7', 5_000)]
// Stripe reports a deleted subscription as `canceled` when you read it back.
const PERIOD_ENDED_REMOTE: Partial<RemoteSubscription> = { status: 'canceled' }

describe('the status worker is the single writer of subscriptions.status (main §4.2)', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('activate: Checkout attaches the customer and writes the first row', async () => {
    stripeHolds(h, ACTIVATE_REMOTE)
    await deliver(h, ACTIVATE)
    expect(status(h)?.status).toBe('active')
    expect(await h.billing.findAccountIdByCustomerId(CUSTOMER)).toBe(ACCOUNT)
    expect(billingGate(await h.billing.readSubscription(ACCOUNT)).generationAllowed).toBe(true)
    expect(h.capture.events.map((e) => e.event)).toContain('subscription_activated')
  })

  it('payment_failed → past_due → paid: generation stops, then resumes', async () => {
    stripeHolds(h, ACTIVATE_REMOTE)
    await deliver(h, ACTIVATE)
    stripeHolds(h, DUNNING_REMOTE)
    await deliver(h, DUNNING)

    expect(status(h)?.status).toBe('past_due')
    const paused = billingGate(await h.billing.readSubscription(ACCOUNT))
    expect(paused.generationAllowed).toBe(false)
    expect(paused.publishingAllowed).toBe(false)
    // Invariant 16 — reads survive a failed payment.
    expect(paused.readAllowed).toBe(true)
    expect(paused.banner.kind).toBe('payment_failed')
    expect(h.notifications.emitted.filter((n) => n.type === 'payment_failed')).toHaveLength(1)

    stripeHolds(h, RECOVERY_REMOTE)
    await deliver(h, RECOVERY)
    expect(status(h)?.status).toBe('active')
    expect(billingGate(await h.billing.readSubscription(ACCOUNT)).generationAllowed).toBe(true)
  })

  it('an invoice never writes the status — only the subscription events do', async () => {
    stripeHolds(h, ACTIVATE_REMOTE)
    await deliver(h, ACTIVATE)
    // Stripe now says past_due, but an invoice event must not read it back:
    // only `customer.subscription.*` writes status (invariant 16's one writer).
    stripeHolds(h, DUNNING_REMOTE)
    await deliver(h, [fixtures.invoicePaymentFailed('evt_solo', 2_500)])
    expect(status(h)?.status).toBe('active')
  })

  it('cancel_at_period_end: entitled to period end, then generation stops for good', async () => {
    stripeHolds(h, ACTIVATE_REMOTE)
    await deliver(h, ACTIVATE)
    stripeHolds(h, CANCEL_AT_PERIOD_END_REMOTE)
    await deliver(h, CANCEL_AT_PERIOD_END)

    const ending = billingGate(await h.billing.readSubscription(ACCOUNT))
    expect(status(h)?.status).toBe('active')
    expect(ending.generationAllowed).toBe(true)
    expect(ending.banner.kind).toBe('ending')

    stripeHolds(h, PERIOD_ENDED_REMOTE)
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
  /**
   * Each scenario is a burst of events plus the state Stripe holds by the time
   * we process them — which is what really happens: Stripe applies the change
   * first and tells us afterwards, so by the time the burst reaches our worker
   * Stripe already holds the end state.
   */
  const scenarios: {
    name: string
    batch: readonly Record<string, unknown>[]
    settled: Partial<RemoteSubscription>
    expected: string
  }[] = [
    { name: 'activate', batch: ACTIVATE, settled: ACTIVATE_REMOTE, expected: 'active' },
    {
      name: 'dunning',
      batch: [...ACTIVATE, ...DUNNING],
      settled: DUNNING_REMOTE,
      expected: 'past_due',
    },
    {
      name: 'recovery',
      batch: [...ACTIVATE, ...DUNNING, ...RECOVERY],
      settled: RECOVERY_REMOTE,
      expected: 'active',
    },
    {
      name: 'cancellation',
      batch: [...ACTIVATE, ...CANCEL_AT_PERIOD_END, ...PERIOD_ENDED],
      settled: PERIOD_ENDED_REMOTE,
      expected: 'canceled',
    },
  ]

  for (const scenario of scenarios) {
    it(`${scenario.name}: in order`, async () => {
      const h = harness()
      stripeHolds(h, scenario.settled)
      await deliver(h, scenario.batch)
      expect(status(h)?.status).toBe(scenario.expected)
    })

    it(`${scenario.name}: processed newest-first still lands on the newest state`, async () => {
      const h = harness()
      stripeHolds(h, scenario.settled)
      // Stripe's at-least-once delivery has no ordering guarantee. Every
      // subscription event re-reads Stripe, so a late arrival re-reads the same
      // settled state rather than writing a stale payload over a fresh one.
      await deliverOneByOne(h, [...scenario.batch].reverse())
      expect(status(h)?.status).toBe(scenario.expected)
    })

    it(`${scenario.name}: shuffled delivery lands on the newest state`, async () => {
      const h = harness()
      stripeHolds(h, scenario.settled)
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
      stripeHolds(h, scenario.settled)
      await deliver(h, scenario.batch)
      const first = { ...status(h) }

      // A redelivery of the same event ids: the store dedupes, and the already
      // processed rows are not drained again.
      await deliver(h, scenario.batch)
      expect({ ...status(h) }).toEqual(first)

      // And a genuine reprocessing of the same payloads — the crash-after-write,
      // before-mark case. The status must not move; only the read stamps do.
      h.events.processed.clear()
      await drainStripeEvents(h.deps)
      expect(status(h)?.status).toBe(first.status)
      expect(status(h)?.cancelAtPeriodEnd).toBe(first.cancelAtPeriodEnd)
    })
  }

  it('one dunning episode sends one payment-failed email however often it is replayed', async () => {
    const h = harness()
    stripeHolds(h, DUNNING_REMOTE)
    await deliver(h, [...ACTIVATE, ...DUNNING])
    await deliver(h, DUNNING)
    h.events.processed.clear()
    await drainStripeEvents(h.deps)
    expect(h.notifications.emitted.filter((n) => n.type === 'payment_failed')).toHaveLength(1)
  })
})

/**
 * The regression this card exists for. Stripe stamps events to the second and
 * routinely fires several for one subscription inside one second; the audit
 * showed that two same-second events which disagree were ordered by whichever
 * random Stripe event id sorted first alphabetically. Landing on a stale "not
 * active" locks a merchant who has just paid out of the product until the
 * nightly reconciliation runs — up to 24 hours.
 */
describe('two events in the same second (T1.2 audit finding)', () => {
  // Same `created`; `evt_aaa` sorts before `evt_zzz`, so under the old
  // payload-ordering rule the past_due event won and the merchant was locked
  // out. The merchant has in fact paid: Stripe holds `active`.
  const SAME_SECOND = 7_000
  const stalePastDue = fixtures.subscriptionUpdated('evt_aaa_stale', SAME_SECOND, {
    status: 'past_due',
  })
  const freshActive = fixtures.subscriptionUpdated('evt_zzz_fresh', SAME_SECOND, {
    status: 'active',
  })

  for (const [name, batch] of [
    ['stale first', [stalePastDue, freshActive]],
    ['stale last', [freshActive, stalePastDue]],
  ] as const) {
    it(`lands on what Stripe actually holds — ${name}`, async () => {
      const h = harness()
      stripeHolds(h, { status: 'active' })
      await deliverOneByOne(h, batch)
      // Not 'past_due': the payload that said so is never written, because each
      // event triggers a fresh read and Stripe says active.
      expect(status(h)?.status).toBe('active')
      expect(billingGate(await h.billing.readSubscription(ACCOUNT)).generationAllowed).toBe(true)
    })
  }

  it('re-reads Stripe once per subscription event, so ordering cannot decide', async () => {
    const h = harness()
    stripeHolds(h, { status: 'active' })
    const before = h.stripe.reads
    await deliverOneByOne(h, [stalePastDue, freshActive])
    // Two subscription events, two reads. If this drops to zero the worker has
    // gone back to trusting the payload and the same-second bug is back.
    expect(h.stripe.reads - before).toBe(2)
  })
})

/**
 * The other regression this card exists for. A merchant finishes paying; the
 * "checkout completed" message names the subscription without describing it, so
 * the worker reads it back. If Stripe answers "no such subscription" — the
 * live-key/test-key mismatch case, where Stripe returns "not found" for every
 * object in the other mode — T1.2 marked the event processed, wrote no row, and
 * nothing ever repaired it. Money taken, no access, no trace.
 */
describe('Stripe cannot find a subscription it just told us about', () => {
  it('does not close the event, so it is retried rather than lost', async () => {
    const h = harness()
    h.stripe.current = null // every read answers "not found"
    await deliver(h, ACTIVATE)

    expect(status(h)).toBeUndefined()
    // The event stays open. Marking it processed would erase the only record
    // that a paying merchant has no entitlement.
    expect(h.events.processed.has('evt_1')).toBe(false)
  })

  it('raises it on the alerting event rather than failing silently', async () => {
    const h = harness()
    h.stripe.current = null
    await deliver(h, ACTIVATE)

    // main §14.7 — `dlq_entry_created` already carries the alert
    // "sustained > 1h", so this surfaces without a new dashboard.
    const dlq = h.capture.events.filter((e) => e.event === 'dlq_entry_created')
    expect(dlq).toHaveLength(1)
    expect(dlq[0]?.properties?.['error_class']).toBe('subscription_not_found')
  })

  it('recovers by itself once the keys are right', async () => {
    const h = harness()
    h.stripe.current = null
    await deliver(h, ACTIVATE)
    expect(status(h)).toBeUndefined()

    // The operator fixes the key; the still-unprocessed event drains again.
    stripeHolds(h, ACTIVATE_REMOTE)
    await drainStripeEvents(h.deps)
    expect(status(h)?.status).toBe('active')
    expect(h.events.processed.has('evt_1')).toBe(true)
  })

  it('the customer is still attached, so the nightly sweep can see the orphan', async () => {
    const h = harness()
    h.stripe.current = null
    await deliver(h, ACTIVATE)
    // `attachCustomer` runs before the read, so the account holds a customer id
    // and no subscription row — which is exactly what `orphanedCustomers` looks
    // for. Without it, nothing in the system could find this merchant.
    expect(await h.billing.orphanedCustomers(10)).toEqual([
      { accountId: ACCOUNT, stripeCustomerId: CUSTOMER },
    ])
  })
})

/**
 * Stripe's `incomplete` means the first payment is still being authorised; it
 * can still succeed. T1.2 stored it as `incomplete_expired` — a merchant who
 * gave up — and fired the `subscription_canceled` funnel event for it, so an
 * account whose card was still being authorised counted as churn from the
 * moment it was created (main §14.7's funnel).
 */
describe('a merchant mid-purchase is not churn', () => {
  it('keeps `incomplete` distinct from `incomplete_expired`', async () => {
    const h = harness()
    stripeHolds(h, { status: 'incomplete' })
    await deliver(h, [fixtures.subscriptionUpdated('evt_inc', 9_000, { status: 'incomplete' })])
    expect(status(h)?.status).toBe('incomplete')
  })

  it('does not report them as cancelled', async () => {
    const h = harness()
    stripeHolds(h, { status: 'incomplete' })
    await deliver(h, [fixtures.subscriptionUpdated('evt_inc', 9_000, { status: 'incomplete' })])
    expect(h.capture.events.map((e) => e.event)).not.toContain('subscription_canceled')
  })

  it('does not report an abandoned purchase as cancelled either', async () => {
    const h = harness()
    stripeHolds(h, { status: 'incomplete_expired' })
    await deliver(h, [
      fixtures.subscriptionUpdated('evt_exp', 9_100, { status: 'incomplete_expired' }),
    ])
    expect(status(h)?.status).toBe('incomplete_expired')
    // Never activated, so there was nothing to churn from. `checkout_started`
    // is what answers "did they abandon Checkout".
    expect(h.capture.events.map((e) => e.event)).not.toContain('subscription_canceled')
  })

  it('still reports a real cancellation', async () => {
    const h = harness()
    stripeHolds(h, ACTIVATE_REMOTE)
    await deliver(h, ACTIVATE)
    stripeHolds(h, PERIOD_ENDED_REMOTE)
    await deliver(h, PERIOD_ENDED)
    expect(h.capture.events.map((e) => e.event)).toContain('subscription_canceled')
  })

  it('neither incomplete state is entitled', async () => {
    for (const state of ['incomplete', 'incomplete_expired'] as const) {
      const h = harness()
      stripeHolds(h, { status: state })
      await deliver(h, [fixtures.subscriptionUpdated(`evt_${state}`, 9_200, { status: state })])
      const gate = billingGate(await h.billing.readSubscription(ACCOUNT))
      expect(gate.generationAllowed).toBe(false)
      expect(gate.publishingAllowed).toBe(false)
      // Invariant 16 — read access is never revoked by billing state.
      expect(gate.readAllowed).toBe(true)
    }
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

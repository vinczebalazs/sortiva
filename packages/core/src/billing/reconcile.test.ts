import { describe, expect, it } from 'vitest'
import { reconcileSubscriptions, staleCutoff, RECONCILE_STALE_AFTER_HOURS } from './reconcile'
import { InMemoryBillingStore, InMemoryStripeEventStore } from './testing'
import type { RemoteSubscription } from './provider'
import type { BillingWorkerDeps } from './processing'

/**
 * Stripe is the source of truth and our row is a cache of it, re-derived
 * nightly because webhooks drop. This is what catches a
 * dropped `customer.subscription.updated`: without it, an account whose payment
 * failed while a webhook was lost would keep generating articles we are not
 * being paid for, indefinitely and silently.
 */

const ACCOUNT = '22222222-2222-4222-8222-222222222222'
const CUSTOMER = 'cus_recon'
const SUBSCRIPTION = 'sub_recon'

function harness(remote: RemoteSubscription | null, now: Date) {
  const billing = new InMemoryBillingStore()
  billing.seedAccount(ACCOUNT, CUSTOMER)
  const deps: BillingWorkerDeps = {
    billing,
    events: new InMemoryStripeEventStore(),
    stripe: { fetchSubscription: async () => remote },
    now: () => now,
  }
  return { billing, deps }
}

const NOW = new Date('2026-08-31T02:00:00Z')
const STALE = new Date('2026-08-28T02:00:00Z')
const FRESH = new Date('2026-08-31T01:00:00Z')

function seed(billing: InMemoryBillingStore, syncedAt: Date) {
  return billing.writeSubscription({
    accountId: ACCOUNT,
    stripeSubscriptionId: SUBSCRIPTION,
    priceId: 'price_monthly',
    status: 'active',
    currentPeriodEnd: new Date('2026-09-30T00:00:00Z'),
    cancelAtPeriodEnd: false,
    stateObservedAt: syncedAt,
  })
}

const remotePastDue: RemoteSubscription = {
  subscriptionId: SUBSCRIPTION,
  customerId: CUSTOMER,
  status: 'past_due',
  priceId: 'price_monthly',
  currentPeriodEnd: new Date('2026-09-30T00:00:00Z'),
  cancelAtPeriodEnd: false,
}

describe('nightly reconciliation (tech §3)', () => {
  it('repairs a row a dropped webhook left wrong', async () => {
    const { billing, deps } = harness(remotePastDue, NOW)
    await seed(billing, STALE)

    const report = await reconcileSubscriptions(deps)

    expect(report.scanned).toBe(1)
    expect(report.repaired).toBe(1)
    expect(billing.rows.get(ACCOUNT)?.status).toBe('past_due')
  })

  it('leaves a row synced inside the window alone', async () => {
    const { billing, deps } = harness(remotePastDue, NOW)
    await seed(billing, FRESH)

    const report = await reconcileSubscriptions(deps)

    expect(report.scanned).toBe(0)
    expect(billing.rows.get(ACCOUNT)?.status).toBe('active')
  })

  /**
   * A comped account has no subscription at the vendor to be re-derived from.
   * Left in the scan it would be fetched with a null id, and "Stripe knows
   * nothing about this" is what the sweep treats as a wrong key — so every
   * comped store would be reported as a billing incident, every night.
   */
  it('never scans a comped row, because there is nothing at the vendor to compare it to', async () => {
    const { billing, deps } = harness(remotePastDue, NOW)
    billing.rows.set(ACCOUNT, {
      accountId: ACCOUNT,
      stripeSubscriptionId: null,
      priceId: null,
      status: 'comped',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      syncedAt: STALE,
      stateObservedAt: STALE,
    })

    const report = await reconcileSubscriptions(deps)

    expect(report.scanned).toBe(0)
    expect(report.missing).toEqual([])
    expect(billing.rows.get(ACCOUNT)?.status).toBe('comped')
  })

  it('reports, never guesses, when Stripe returns nothing for a subscription we hold', async () => {
    const { billing, deps } = harness(null, NOW)
    await seed(billing, STALE)

    const report = await reconcileSubscriptions(deps)

    expect(report.missing).toEqual([SUBSCRIPTION])
    // A wrong key or the wrong Stripe mode must not cancel a paying customer.
    expect(billing.rows.get(ACCOUNT)?.status).toBe('active')
  })

  it('always wins the ordering guard, because a fetch is the newest view there is', async () => {
    const { billing, deps } = harness(remotePastDue, NOW)
    // A row whose stored state claims to be from the future — a clock skew, or
    // an event Stripe stamped ahead of us.
    await seed(billing, new Date('2027-01-01T00:00:00Z'))

    const report = await reconcileSubscriptions(deps, { staleAfterHours: -1_000_000 })

    expect(report.repaired).toBe(1)
    expect(billing.rows.get(ACCOUNT)?.status).toBe('past_due')
  })

  it('uses the 24h window tech §3 states', () => {
    expect(RECONCILE_STALE_AFTER_HOURS).toBe(24)
    expect(staleCutoff(new Date('2026-08-31T02:00:00Z'))).toEqual(
      new Date('2026-08-30T02:00:00Z'),
    )
  })
})

/**
 * The sweep above only ever scanned rows that already exist, so a merchant who
 * paid and never got a subscription row was invisible to it: there is no row to
 * be stale. That is the state a live-key/test-key mismatch leaves behind, and
 * it is the one state where the merchant has been charged and has no access.
 */
describe('a merchant who paid and has no subscription row', () => {
  it('is found by the nightly sweep and raised on the alerting event', async () => {
    const { billing, deps } = harness(remotePastDue, NOW)
    const captured: { event: string; properties?: Record<string, unknown> }[] = []
    // `seedAccount` attached the customer id; no subscription row was written,
    // which is exactly what `checkout.session.completed` leaves behind when the
    // read-back fails.
    const report = await reconcileSubscriptions(
      { ...deps, capture: { capture: (e) => void captured.push(e) } },
      {},
    )

    expect(report.orphaned).toEqual([ACCOUNT])
    expect(billing.rows.get(ACCOUNT)).toBeUndefined()

    const dlq = captured.filter((e) => e.event === 'dlq_entry_created')
    expect(dlq).toHaveLength(1)
    expect(dlq[0]?.properties?.['error_class']).toBe('customer_without_subscription')
  })

  it('stops reporting the account once the row exists', async () => {
    const { billing, deps } = harness(remotePastDue, NOW)
    await seed(billing, FRESH)

    const report = await reconcileSubscriptions(deps, {})
    expect(report.orphaned).toEqual([])
  })
})

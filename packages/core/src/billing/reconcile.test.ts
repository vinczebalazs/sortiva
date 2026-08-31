import { describe, expect, it } from 'vitest'
import { reconcileSubscriptions, staleCutoff, RECONCILE_STALE_AFTER_HOURS } from './reconcile'
import { InMemoryBillingStore, InMemoryStripeEventStore } from './testing'
import type { RemoteSubscription } from './provider'
import type { BillingWorkerDeps } from './processing'

/**
 * main §4.2 — "Stripe is the source of truth; our row is a cache of it,
 * reconciled nightly … because webhooks drop here too." This is what catches a
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
    observedAt: syncedAt,
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

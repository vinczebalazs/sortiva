import { accountAttribution } from '../contracts/analytics'
import {
  applyRemoteSubscription,
  DLQ_ENTRY_CREATED_EVENT,
  type BillingWorkerDeps,
  type ProcessOutcome,
} from './processing'

/**
 * Stripe is the source of truth and our row is a cache of it, so it is
 * re-derived nightly — webhooks drop here as everywhere else, and a merchant
 * wrongly cut off or wrongly entitled is not something to discover from a
 * support ticket.
 *
 * The billing analogue of the catalog drift sweep: never assume a delivery
 * arrived, re-derive on a schedule. It runs in a scheduled job and never in a
 * request path, which is what keeps Stripe's availability out of the product.
 */

/** How stale a row may be before the nightly job re-fetches it, in hours. */
export const RECONCILE_STALE_AFTER_HOURS = 24

const MS_PER_HOUR = 3_600_000

/** How many stale rows one nightly pass repairs. A batch size, not a rules threshold. */
export const RECONCILE_BATCH_SIZE = 500

export interface ReconcileReport {
  readonly scanned: number
  readonly repaired: number
  /** Stripe returned nothing for a subscription id we hold. Reported, never guessed at. */
  readonly missing: readonly string[]
  /**
   * Accounts holding a Stripe customer id and no subscription row — merchants
   * who reached Checkout and are not entitled. Before this card nothing in the
   * system looked for them, because the sweep only ever scanned rows that
   * already existed.
   */
  readonly orphaned: readonly string[]
  readonly outcomes: readonly ProcessOutcome[]
}

/** How many orphaned customers one pass reports. A batch size, not a threshold. */
export const ORPHAN_SCAN_LIMIT = 500

export function staleCutoff(now: Date, hours: number = RECONCILE_STALE_AFTER_HOURS): Date {
  return new Date(now.getTime() - hours * MS_PER_HOUR)
}

export async function reconcileSubscriptions(
  deps: BillingWorkerDeps,
  options: { limit?: number; staleAfterHours?: number; orphanLimit?: number } = {},
): Promise<ReconcileReport> {
  const now = deps.now?.() ?? new Date()
  const cutoff = staleCutoff(now, options.staleAfterHours ?? RECONCILE_STALE_AFTER_HOURS)
  const stale = await deps.billing.staleSubscriptions(cutoff, options.limit ?? RECONCILE_BATCH_SIZE)

  const outcomes: ProcessOutcome[] = []
  const missing: string[] = []

  for (const row of stale) {
    const remote = await deps.stripe.fetchSubscription(row.stripeSubscriptionId)
    if (!remote) {
      // Stripe keeps cancelled subscriptions readable, so "not found" means a
      // wrong id or the wrong mode's keys — never "it was deleted". Writing a
      // status off the back of that guess would let a key rotation cancel a
      // paying customer, so the row is left alone and the id is reported.
      missing.push(row.stripeSubscriptionId)
      continue
    }
    // A re-fetch *is* the newest view of Stripe that exists, so it must win the
    // write guard even against a row stamped in the future — a clock skew or a
    // stamp written ahead of us would otherwise make the row permanently
    // unrepairable, which is the exact failure this sweep exists to prevent.
    const fetchedAt = deps.now?.() ?? new Date()
    const stateObservedAt = new Date(Math.max(fetchedAt.getTime(), row.stateObservedAt.getTime()))

    outcomes.push(
      await applyRemoteSubscription(deps, row.accountId, remote, stateObservedAt, {
        eventId: `reconcile:${row.stripeSubscriptionId}`,
        type: 'subscription_reconciliation_nightly',
      }),
    )
  }

  const orphaned = await findOrphanedCustomers(deps, options.orphanLimit ?? ORPHAN_SCAN_LIMIT)

  return {
    scanned: stale.length,
    repaired: outcomes.filter((o) => o.action === 'applied').length,
    missing,
    orphaned,
    outcomes,
  }
}

/**
 * The repair path for a merchant who paid and never became entitled.
 *
 * `checkout.session.completed` attaches the Stripe customer id to the account
 * before it reads the subscription back, so an account with a customer id and
 * no subscription row is one where that read did not produce a row — the
 * live-key/test-key mismatch case above, or a drain that never resumed. The
 * staleness sweep cannot see these accounts at all, because there is no row to
 * be stale.
 *
 * Reported, never guessed at: we do not know which subscription the merchant
 * bought without Stripe answering, so this raises the alert and stops.
 */
async function findOrphanedCustomers(
  deps: BillingWorkerDeps,
  limit: number,
): Promise<readonly string[]> {
  const orphans = await deps.billing.orphanedCustomers(limit)
  for (const orphan of orphans) {
    deps.capture?.capture({
      event: DLQ_ENTRY_CREATED_EVENT,
      attribution: accountAttribution(orphan.accountId),
      properties: {
        step: 'subscription_reconciliation_nightly',
        error_class: 'customer_without_subscription',
        stripe_customer_id: orphan.stripeCustomerId,
      },
    })
    console.error(
      `[billing] account ${orphan.accountId} has Stripe customer ${orphan.stripeCustomerId} ` +
        `and no subscription row: it is NOT entitled. Check that the Stripe API key ` +
        `matches the mode the customer was created in.`,
    )
  }
  return orphans.map((o) => o.accountId)
}

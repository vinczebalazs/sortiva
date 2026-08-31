import { applyRemoteSubscription, type BillingWorkerDeps, type ProcessOutcome } from './processing'

/**
 * main §4.2 — "Stripe is the source of truth; our row is a cache of it,
 * **reconciled nightly** … because webhooks drop here too." tech §3 fixes the
 * staleness window: "re-fetches any subscription whose `synced_at` is >24h
 * stale".
 *
 * This is the billing analogue of the catalog sweep (main §14.3.8): the system
 * never assumes a delivery arrived, it re-derives from the vendor on a
 * schedule. It runs in a scheduled job, not a request path, which is the line
 * invariant 16 draws.
 */

/** tech §3 — the staleness window, in hours. */
export const RECONCILE_STALE_AFTER_HOURS = 24

const MS_PER_HOUR = 3_600_000

/** How many stale rows one nightly pass repairs. A batch size, not a rules threshold. */
export const RECONCILE_BATCH_SIZE = 500

export interface ReconcileReport {
  readonly scanned: number
  readonly repaired: number
  /** Stripe returned nothing for a subscription id we hold. Reported, never guessed at. */
  readonly missing: readonly string[]
  readonly outcomes: readonly ProcessOutcome[]
}

export function staleCutoff(now: Date, hours: number = RECONCILE_STALE_AFTER_HOURS): Date {
  return new Date(now.getTime() - hours * MS_PER_HOUR)
}

export async function reconcileSubscriptions(
  deps: BillingWorkerDeps,
  options: { limit?: number; staleAfterHours?: number } = {},
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
    // write guard even against a row stamped in the future — a clock skew or an
    // event Stripe stamped ahead of us would otherwise make the row permanently
    // unrepairable, which is the exact failure this sweep exists to prevent.
    const fetchedAt = deps.now?.() ?? new Date()
    const observedAt = new Date(Math.max(fetchedAt.getTime(), row.syncedAt.getTime()))

    outcomes.push(
      await applyRemoteSubscription(deps, row.accountId, remote, observedAt, {
        eventId: `reconcile:${row.stripeSubscriptionId}`,
        type: 'subscription_reconciliation_nightly',
      }),
    )
  }

  return {
    scanned: stale.length,
    repaired: outcomes.filter((o) => o.action === 'applied').length,
    missing,
    outcomes,
  }
}

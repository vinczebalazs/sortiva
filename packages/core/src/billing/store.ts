import type { LocalSubscription, SubscriptionStatus } from './entitlement'

/**
 * `packages/core` owns domain logic and no persistence (constitution
 * code-structure rules), so the billing worker talks to ports. `apps/web` binds
 * them to `@sortiva/db`.
 */

export interface SubscriptionWrite {
  readonly accountId: string
  readonly stripeSubscriptionId: string
  readonly priceId: string
  readonly status: SubscriptionStatus
  readonly currentPeriodEnd: Date | null
  readonly cancelAtPeriodEnd: boolean
  /**
   * The **Stripe-side** time of the state being written, stored in
   * `subscriptions.synced_at`. It is both the ordering guard for out-of-order
   * webhook delivery and the staleness clock the nightly reconciliation scans
   * on (tech §3). See DECISIONS 2026-08-31 T1.2.
   */
  readonly observedAt: Date
}

export interface SubscriptionWriteResult {
  /** False when the guard rejected the write because newer state is already stored. */
  readonly applied: boolean
  /** The status the row held before this call; null when there was no row. */
  readonly previousStatus: SubscriptionStatus | null
}

export interface StaleSubscription {
  readonly accountId: string
  readonly stripeSubscriptionId: string
  readonly syncedAt: Date
}

/**
 * Invariant 16 — the only writer of `subscriptions` is the Stripe webhook
 * worker (and the nightly reconciliation, which is the same code path fed from
 * a re-fetch). Nothing else in the system implements this interface.
 */
export interface BillingStore {
  /** main §13 — `accounts.stripe_customer_id` is how a webhook finds its account. */
  findAccountIdByCustomerId(customerId: string): Promise<string | null>
  accountExists(accountId: string): Promise<boolean>
  /** Idempotent: writing the customer id it already holds is a no-op. */
  attachCustomer(accountId: string, customerId: string): Promise<void>
  /**
   * Guarded upsert (`UPDATE … WHERE synced_at <= $observedAt`), so replaying an
   * older event cannot roll a newer status back — invariant 15's discipline
   * applied to the one table Stripe writes.
   */
  writeSubscription(write: SubscriptionWrite): Promise<SubscriptionWriteResult>
  readSubscription(accountId: string): Promise<LocalSubscription | null>
  /** tech §3 — "re-fetches any subscription whose `synced_at` is >24h stale". */
  staleSubscriptions(olderThan: Date, limit: number): Promise<readonly StaleSubscription[]>
}

export interface StoredStripeEvent {
  readonly eventId: string
  readonly type: string
  readonly payload: Record<string, unknown>
  readonly receivedAt: Date
}

/**
 * main §14.3.8 / tech §3 — insert-or-ignore by Stripe's event id, 200
 * immediately, process from the table rather than from the request body.
 */
export interface StripeEventStore {
  /** False when this event id was already stored — Stripe's at-least-once retry. */
  record(event: Omit<StoredStripeEvent, 'receivedAt'>): Promise<boolean>
  /** Oldest first, so a burst is applied in the order Stripe generated it. */
  claimUnprocessed(limit: number): Promise<readonly StoredStripeEvent[]>
  markProcessed(eventId: string): Promise<void>
}

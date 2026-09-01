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
   * The moment **we read this state from Stripe**, stored in
   * `subscriptions.state_observed_at`, which is the monotonic guard on the
   * upsert. Every write now originates in a Stripe read (see
   * `handleSubscriptionState`), so this is always a read time and never a
   * timestamp lifted off an event payload. See DECISIONS 2026-09-01 T1.2a.
   */
  readonly stateObservedAt: Date
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
  /** The stored ordering floor, so a repair can be stamped to clear it. */
  readonly stateObservedAt: Date
}

/**
 * An account that reached Stripe Checkout — it has a customer id — and holds no
 * subscription row, so it is paying (or has paid) and is not entitled.
 *
 * The nightly reconciliation only ever scanned rows that already exist, so this
 * account was invisible to every repair path in the system. See
 * `reconcileSubscriptions`.
 */
export interface OrphanedCustomer {
  readonly accountId: string
  readonly stripeCustomerId: string
}

/**
 * Invariant 16 — the only writer of `subscriptions` is the Stripe webhook
 * worker (and the nightly reconciliation, which is the same code path fed from
 * a re-fetch). Nothing else in the system implements this interface.
 */
export interface BillingStore {
  /** `accounts.stripe_customer_id` is how a webhook finds the account it belongs to. */
  findAccountIdByCustomerId(customerId: string): Promise<string | null>
  accountExists(accountId: string): Promise<boolean>
  /** Idempotent: writing the customer id it already holds is a no-op. */
  attachCustomer(accountId: string, customerId: string): Promise<void>
  /**
   * Guarded upsert (`… WHERE state_observed_at <= $stateObservedAt`), so a
   * write carrying an older read of Stripe cannot roll a newer status back —
   * invariant 15's discipline applied to the one table Stripe writes.
   */
  writeSubscription(write: SubscriptionWrite): Promise<SubscriptionWriteResult>
  readSubscription(accountId: string): Promise<LocalSubscription | null>
  /** Rows the nightly reconciliation should re-fetch, because we have not heard about them recently enough. */
  staleSubscriptions(olderThan: Date, limit: number): Promise<readonly StaleSubscription[]>
  /**
   * Accounts with a Stripe customer id and no subscription row. Nothing else in
   * the system notices these, and a merchant in this state has paid and is not
   * entitled.
   */
  orphanedCustomers(limit: number): Promise<readonly OrphanedCustomer[]>
  /**
   * Records that we successfully contacted Stripe about this row without
   * changing the state it holds — the staleness clock only. Never touches
   * `state_observed_at`, so it cannot move the ordering floor.
   */
  markSynced(accountId: string, syncedAt: Date): Promise<void>
}

export interface StoredStripeEvent {
  readonly eventId: string
  readonly type: string
  readonly payload: Record<string, unknown>
  readonly receivedAt: Date
}

/**
 * Insert-or-ignore by Stripe's event id, answer 200 immediately, and process
 * from the table rather than from the request body.
 */
export interface StripeEventStore {
  /** False when this event id was already stored — Stripe's at-least-once retry. */
  record(event: Omit<StoredStripeEvent, 'receivedAt'>): Promise<boolean>
  /** Oldest first. Ordering is no longer load-bearing (see `handleSubscriptionState`). */
  claimUnprocessed(limit: number): Promise<readonly StoredStripeEvent[]>
  markProcessed(eventId: string): Promise<void>
  /**
   * Runs `body` only if no other drain is running, and returns `null` when one
   * is. `claimUnprocessed` is a plain select, so without this two webhooks
   * arriving milliseconds apart start two drains over the same rows — which now
   * means two Stripe reads and two funnel captures per event.
   *
   * Optional so a test double need not implement it; unset means "run it".
   */
  withDrainLock?<T>(body: () => Promise<T>): Promise<T | null>
}

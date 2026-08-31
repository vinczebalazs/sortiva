import { accountAttribution, type PosthogCapture } from '../contracts/analytics'
import type { NotificationEmitter } from '../contracts/opportunities'
import { parseBillingEvent, type BillingEvent, type SubscriptionSnapshot } from './events'
import type { RemoteSubscription, StripeBillingProvider } from './provider'
import type { BillingStore, StoredStripeEvent, StripeEventStore, SubscriptionWrite } from './store'
import type { SubscriptionStatus } from './entitlement'

/**
 * main §4.2, tech §3 — the **single writer** of `subscriptions.status`.
 * Nothing else in the system implements a write to that column, and everything
 * that asks "is this account entitled" reads the row this worker maintains
 * (invariant 16).
 *
 * Effectively-once by construction (invariant 18): the receiver has already
 * deduped on Stripe's event id, the subscription write is guarded on the
 * Stripe-side timestamp of the state it carries, and the payment-failed
 * notification dedupes on tech §1.2's `(account_id, type, dedupe_key)` triple.
 * So the same event replayed, or two events arriving in the wrong order, land
 * on the same stored state as a clean in-order run.
 */

export interface BillingWorkerDeps {
  readonly billing: BillingStore
  readonly events: StripeEventStore
  /**
   * The one Stripe call this worker makes: reading a subscription Stripe told
   * us about but did not describe. It is not in a request path and not at
   * scheduler dequeue, which is what invariant 16 forbids.
   */
  readonly stripe: Pick<StripeBillingProvider, 'fetchSubscription'>
  readonly notifications?: NotificationEmitter
  readonly capture?: Pick<PosthogCapture, 'capture'>
  readonly now?: () => Date
}

export type ProcessAction =
  /** The stored state changed, or was confirmed by an equally-fresh event. */
  | 'applied'
  /** Older than what is stored — an out-of-order or replayed delivery. */
  | 'stale'
  /** A type main §4.2 does not list, or one that carries no state to write. */
  | 'ignored'
  /** Stripe named a customer or account we hold no row for. */
  | 'unresolved'

export interface ProcessOutcome {
  readonly eventId: string
  readonly type: string
  readonly action: ProcessAction
  readonly accountId?: string
  readonly detail?: string
}

/** main §14.7 funnel events. */
export const SUBSCRIPTION_ACTIVATED_EVENT = 'subscription_activated'
export const PAYMENT_FAILED_EVENT = 'payment_failed'
export const SUBSCRIPTION_CANCELED_EVENT = 'subscription_canceled'

export async function processStripeEvent(
  deps: BillingWorkerDeps,
  stored: StoredStripeEvent,
): Promise<ProcessOutcome> {
  const event = parseBillingEvent({
    id: stored.eventId,
    type: stored.type,
    created: eventCreatedAt(stored),
    payload: stored.payload,
  })

  switch (event.kind) {
    case 'checkout_completed':
      return handleCheckoutCompleted(deps, event)
    case 'subscription_state':
      return handleSubscriptionState(deps, event)
    case 'invoice_outcome':
      // main §4.2 names `customer.subscription.updated`/`.deleted` as the status
      // writers. An invoice tells us money moved, never what the subscription
      // now is — Stripe sends the subscription event for that, and deciding
      // status from an invoice would put a second writer on the column.
      return { eventId: event.eventId, type: stored.type, action: 'ignored', detail: 'invoice' }
    case 'ignored':
      return { eventId: event.eventId, type: stored.type, action: 'ignored', detail: 'unhandled type' }
  }
}

/**
 * main §4.2 — "`checkout.session.completed` (attach customer + subscription to
 * account)". The session names the subscription but does not describe it, so
 * the worker reads it once from Stripe and writes the first `subscriptions`
 * row. Without that read the account would hold no row — and therefore no
 * entitlement — until Stripe's next subscription event, which for a healthy
 * monthly plan is a month away.
 */
async function handleCheckoutCompleted(
  deps: BillingWorkerDeps,
  event: Extract<BillingEvent, { kind: 'checkout_completed' }>,
): Promise<ProcessOutcome> {
  const type = 'checkout.session.completed'
  if (!event.accountId || !event.customerId) {
    return { eventId: event.eventId, type, action: 'unresolved', detail: 'no account or customer' }
  }
  if (!(await deps.billing.accountExists(event.accountId))) {
    return { eventId: event.eventId, type, action: 'unresolved', detail: 'unknown account' }
  }

  await deps.billing.attachCustomer(event.accountId, event.customerId)

  if (!event.subscriptionId) {
    return { eventId: event.eventId, type, action: 'applied', accountId: event.accountId, detail: 'customer attached' }
  }

  const remote = await deps.stripe.fetchSubscription(event.subscriptionId)
  if (!remote) {
    return { eventId: event.eventId, type, action: 'unresolved', accountId: event.accountId, detail: 'subscription not found' }
  }

  return applySubscription(deps, event.accountId, remoteToSnapshot(remote), event.occurredAt, {
    eventId: event.eventId,
    type,
  })
}

async function handleSubscriptionState(
  deps: BillingWorkerDeps,
  event: Extract<BillingEvent, { kind: 'subscription_state' }>,
): Promise<ProcessOutcome> {
  const type = event.deleted ? 'customer.subscription.deleted' : 'customer.subscription.updated'
  const accountId = await deps.billing.findAccountIdByCustomerId(event.subscription.customerId)
  if (!accountId) {
    return { eventId: event.eventId, type, action: 'unresolved', detail: 'unknown customer' }
  }
  return applySubscription(deps, accountId, event.subscription, event.occurredAt, {
    eventId: event.eventId,
    type,
  })
}

async function applySubscription(
  deps: BillingWorkerDeps,
  accountId: string,
  snapshot: SubscriptionSnapshot,
  observedAt: Date,
  origin: { eventId: string; type: string },
): Promise<ProcessOutcome> {
  const write: SubscriptionWrite = {
    accountId,
    stripeSubscriptionId: snapshot.subscriptionId,
    priceId: snapshot.priceId,
    status: snapshot.status,
    currentPeriodEnd: snapshot.currentPeriodEnd,
    cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
    observedAt,
  }

  const result = await deps.billing.writeSubscription(write)
  if (!result.applied) {
    return {
      ...origin,
      action: 'stale',
      accountId,
      detail: 'newer subscription state is already stored',
    }
  }

  await announce(deps, accountId, snapshot, result.previousStatus)
  return { ...origin, action: 'applied', accountId, detail: snapshot.status }
}

/**
 * main §4.2 — the dunning email and the funnel events. The notification dedupes
 * on tech §1.2's triple rather than on "did the status change", so a worker
 * that crashed between the write and the emit still sends exactly one email
 * when it retries.
 */
async function announce(
  deps: BillingWorkerDeps,
  accountId: string,
  snapshot: SubscriptionSnapshot,
  previousStatus: SubscriptionStatus | null,
): Promise<void> {
  const attribution = accountAttribution(accountId)
  const changed = previousStatus !== snapshot.status

  if (snapshot.status === 'past_due') {
    await deps.notifications?.emit(
      'payment_failed',
      { subscription_id: snapshot.subscriptionId },
      dunningDedupeKey(snapshot),
      attribution,
    )
    if (changed) {
      deps.capture?.capture({
        event: PAYMENT_FAILED_EVENT,
        attribution,
        properties: { previous_status: previousStatus },
      })
    }
    return
  }

  if (!changed) return

  if (snapshot.status === 'active') {
    deps.capture?.capture({
      event: SUBSCRIPTION_ACTIVATED_EVENT,
      attribution,
      properties: { previous_status: previousStatus, price_id: snapshot.priceId },
    })
    return
  }

  if (snapshot.status === 'canceled' || snapshot.status === 'incomplete_expired') {
    deps.capture?.capture({
      event: SUBSCRIPTION_CANCELED_EVENT,
      attribution,
      properties: { previous_status: previousStatus, status: snapshot.status },
    })
  }
}

/**
 * One email per dunning episode, not one per retry. Stripe Smart Retries emits
 * a subscription event on every attempt while the status stays `past_due`; the
 * billing period is what identifies the episode.
 */
function dunningDedupeKey(snapshot: SubscriptionSnapshot): string {
  const period = snapshot.currentPeriodEnd?.toISOString() ?? 'no-period'
  return `${snapshot.subscriptionId}:past_due:${period}`
}

/**
 * The nightly reconciliation's write path (tech §3). Same guarded write, same
 * funnel events as a webhook — a row repaired by the sweep must be
 * indistinguishable from one Stripe told us about, or the two paths drift.
 *
 * `observedAt` is the moment of the fetch, so a re-fetch always wins the
 * ordering guard: it *is* the newest view of Stripe that exists.
 */
export async function applyRemoteSubscription(
  deps: BillingWorkerDeps,
  accountId: string,
  remote: RemoteSubscription,
  observedAt: Date,
  origin: { eventId: string; type: string },
): Promise<ProcessOutcome> {
  return applySubscription(deps, accountId, remoteToSnapshot(remote), observedAt, origin)
}

function remoteToSnapshot(remote: RemoteSubscription): SubscriptionSnapshot {
  return {
    subscriptionId: remote.subscriptionId,
    customerId: remote.customerId,
    status: remote.status,
    priceId: remote.priceId,
    currentPeriodEnd: remote.currentPeriodEnd,
    cancelAtPeriodEnd: remote.cancelAtPeriodEnd,
  }
}

/**
 * Stripe's `created` on the envelope is the ordering key. A stored row that
 * somehow lost it falls back to when we received it, which is monotonic on our
 * side and therefore still safe for the guard.
 */
function eventCreatedAt(stored: StoredStripeEvent): Date {
  const created = stored.payload['created']
  if (typeof created === 'number' && Number.isFinite(created)) return new Date(created * 1000)
  return stored.receivedAt
}

/** How many stored events one drain pass takes. Not a rules threshold; a batch size. */
export const DRAIN_BATCH_SIZE = 100

/**
 * tech §3 — the receiver returns 200 the moment the event is stored; this is
 * the "process async" half. Draining the table rather than trusting an enqueue
 * means an event that was stored while the queue was unreachable is still
 * picked up on the next pass.
 */
export async function drainStripeEvents(
  deps: BillingWorkerDeps,
  options: { limit?: number } = {},
): Promise<readonly ProcessOutcome[]> {
  const batch = await deps.events.claimUnprocessed(options.limit ?? DRAIN_BATCH_SIZE)
  const outcomes: ProcessOutcome[] = []
  for (const stored of batch) {
    const outcome = await processStripeEvent(deps, stored)
    // Marked processed for every terminal outcome, `unresolved` included: a
    // customer we hold no account for is not going to become resolvable by
    // replaying the same payload, and the nightly reconciliation is what
    // repairs a row that genuinely drifted.
    await deps.events.markProcessed(stored.eventId)
    outcomes.push(outcome)
  }
  return outcomes
}

import { accountAttribution, type PosthogCapture } from '../contracts/analytics'
import type { NotificationEmitter } from '../contracts/opportunities'
import { parseBillingEvent, type BillingEvent, type SubscriptionSnapshot } from './events'
import type { RemoteSubscription, StripeBillingProvider } from './provider'
import type { BillingStore, StoredStripeEvent, StripeEventStore, SubscriptionWrite } from './store'
import type { SubscriptionStatus } from './entitlement'

/**
 * The **single writer** of `subscriptions.status`. Nothing else in the system
 * writes that column, and everything that asks "is this account entitled" reads
 * the row this worker maintains — so entitlement never depends on Stripe being
 * reachable at the moment someone clicks something.
 *
 * Safe to run twice by construction: the receiver has already deduped on
 * Stripe's event id, the subscription write is guarded on the Stripe-side
 * timestamp of the state it carries, and the payment-failed notification
 * dedupes on `(account_id, type, dedupe_key)`. So the same event replayed, or
 * two events arriving in the wrong order, land on the same stored state as a
 * clean in-order run.
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
  /** A type we do not act on, or one that carries no state to write. */
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

/** The subscription funnel events. */
export const SUBSCRIPTION_ACTIVATED_EVENT = 'subscription_activated'
export const PAYMENT_FAILED_EVENT = 'payment_failed'
export const SUBSCRIPTION_CANCELED_EVENT = 'subscription_canceled'
/**
 * Billing reuses the existing dead-letter event rather than inventing one of
 * its own, because that event already has an alert behind it. A new event name
 * would mean a new dashboard nobody has built and nobody is watching.
 */
export const DLQ_ENTRY_CREATED_EVENT = 'dlq_entry_created'

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
      // Only the subscription events write status. An invoice tells us money
      // moved, never what the subscription
      // now is — Stripe sends the subscription event for that, and deciding
      // status from an invoice would put a second writer on the column.
      return { eventId: event.eventId, type: stored.type, action: 'ignored', detail: 'invoice' }
    case 'ignored':
      return { eventId: event.eventId, type: stored.type, action: 'ignored', detail: 'unhandled type' }
  }
}

/**
 * Attaches the Stripe customer and subscription to the account.
 *
 * The checkout session names the subscription but does not describe it, so
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
    // The merchant has paid. If we cannot read back what they bought, they hold
    // no subscription row and therefore no entitlement — so this must never be
    // swallowed. See `unresolvedSubscription`.
    return unresolvedSubscription(deps, {
      eventId: event.eventId,
      type,
      accountId: event.accountId,
      subscriptionId: event.subscriptionId,
    })
  }

  return applySubscription(deps, event.accountId, remoteToSnapshot(remote), observedNow(deps), {
    eventId: event.eventId,
    type,
  })
}

/**
 * Stripe named a subscription and then answered "no such subscription".
 *
 * The realistic trigger is a live-key/test-key mismatch — production holding a
 * test-mode key, or the reverse — because Stripe answers "not found" for every
 * object belonging to the other mode. That is a launch-day configuration
 * mistake that would otherwise silently swallow every new subscriber: money
 * taken, no access, no trace.
 *
 * So it is raised as a dead-letter entry, which already carries an alert for
 * sustained volume. The caller returns `unresolved`, and `drainStripeEvents`
 * deliberately leaves the event unprocessed so it is retried rather than
 * closed.
 */
function unresolvedSubscription(
  deps: BillingWorkerDeps,
  origin: { eventId: string; type: string; accountId: string; subscriptionId: string },
): ProcessOutcome {
  deps.capture?.capture({
    event: DLQ_ENTRY_CREATED_EVENT,
    attribution: accountAttribution(origin.accountId),
    properties: {
      step: 'stripe_subscription_read',
      error_class: 'subscription_not_found',
      stripe_event_type: origin.type,
      stripe_event_id: origin.eventId,
      subscription_id: origin.subscriptionId,
    },
  })
  console.error(
    `[billing] Stripe has no subscription ${origin.subscriptionId} for account ${origin.accountId} ` +
      `(event ${origin.eventId}, ${origin.type}). The account is NOT entitled. ` +
      `Most likely cause: the Stripe API key is for the other mode (test vs live).`,
  )
  return {
    eventId: origin.eventId,
    type: origin.type,
    action: 'unresolved',
    accountId: origin.accountId,
    detail: 'subscription not found in Stripe',
  }
}

/**
 * A `customer.subscription.*` event is treated as a **signal that the
 * subscription changed**, not as a description of what it changed to: the
 * worker re-reads the subscription from Stripe and stamps it with the moment of
 * that read.
 *
 * Why, concretely: Stripe stamps its events to the second and routinely fires
 * several for one subscription inside the same second. Using the event payload
 * meant two same-second events that disagree were ordered by whichever random
 * Stripe event id sorted first alphabetically — so a stale "not active" could
 * beat the "active" that arrived with it and lock out a merchant who had just
 * paid, until the nightly reconciliation ran up to 24h later.
 *
 * A fresh read cannot lose that race: it is by definition the newest view of
 * Stripe that exists, so ordering stops mattering. It also makes this path
 * agree with `checkout.session.completed`, which already worked this way.
 *
 * Reading Stripe here is allowed because the rule is that no *request path* and
 * no scheduler dequeue may call them — a webhook worker is neither, and a slow
 * Stripe here delays a background write rather than a merchant's page. Cost is
 * one read per subscription event, on a stream bounded by merchant count.
 */
async function handleSubscriptionState(
  deps: BillingWorkerDeps,
  event: Extract<BillingEvent, { kind: 'subscription_state' }>,
): Promise<ProcessOutcome> {
  const type = event.deleted ? 'customer.subscription.deleted' : 'customer.subscription.updated'
  const accountId = await deps.billing.findAccountIdByCustomerId(event.subscription.customerId)
  if (!accountId) {
    return { eventId: event.eventId, type, action: 'unresolved', detail: 'unknown customer' }
  }

  const remote = await deps.stripe.fetchSubscription(event.subscription.subscriptionId)
  if (!remote) {
    // Stripe keeps cancelled subscriptions readable, so "not found" never means
    // "it was deleted" — it means a wrong id, or our keys are pointed at the
    // other Stripe mode. Writing a status off that guess would let a key
    // rotation cancel a paying customer. Leave the row alone and raise it.
    return unresolvedSubscription(deps, {
      eventId: event.eventId,
      type,
      accountId,
      subscriptionId: event.subscription.subscriptionId,
    })
  }

  return applySubscription(deps, accountId, remoteToSnapshot(remote), observedNow(deps), {
    eventId: event.eventId,
    type,
  })
}

/** The moment of the Stripe read — the ordering stamp every write now carries. */
function observedNow(deps: BillingWorkerDeps): Date {
  return deps.now?.() ?? new Date()
}

async function applySubscription(
  deps: BillingWorkerDeps,
  accountId: string,
  snapshot: SubscriptionSnapshot,
  stateObservedAt: Date,
  origin: { eventId: string; type: string },
): Promise<ProcessOutcome> {
  const write: SubscriptionWrite = {
    accountId,
    stripeSubscriptionId: snapshot.subscriptionId,
    priceId: snapshot.priceId,
    status: snapshot.status,
    currentPeriodEnd: snapshot.currentPeriodEnd,
    cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
    stateObservedAt,
  }

  const result = await deps.billing.writeSubscription(write)
  if (!result.applied) {
    // We did reach Stripe, so the row is not stale even though this particular
    // read lost the race. Advancing the staleness clock
    // alone keeps the nightly scan off a row that is demonstrably current,
    // without touching the ordering floor.
    await deps.billing.markSynced(accountId, stateObservedAt)
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
 * The dunning email and the funnel events. The notification dedupes on
 * `(account_id, type, dedupe_key)` rather than on "did the status change", so a
 * worker
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

  // Only a real cancellation is churn. `incomplete` is a merchant whose first
  // payment is still being authorised and `incomplete_expired` one who never
  // completed it — neither ever reached `active`, so counting them here would
  // report an account as churned from the moment it was created, which would
  // make the funnel useless. A subscription that never activated is a
  // Checkout-abandonment question, which `checkout_started` already answers.
  if (snapshot.status === 'canceled') {
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
 * The nightly reconciliation's write path. Same guarded write, same
 * funnel events as a webhook — a row repaired by the sweep must be
 * indistinguishable from one Stripe told us about, or the two paths drift.
 *
 * `stateObservedAt` is the moment of the fetch, so a re-fetch always wins the
 * ordering guard: it *is* the newest view of Stripe that exists. Every webhook
 * path now works the same way, so this is no longer a special case.
 */
export async function applyRemoteSubscription(
  deps: BillingWorkerDeps,
  accountId: string,
  remote: RemoteSubscription,
  stateObservedAt: Date,
  origin: { eventId: string; type: string },
): Promise<ProcessOutcome> {
  return applySubscription(deps, accountId, remoteToSnapshot(remote), stateObservedAt, origin)
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
 * Stripe's `created` on the envelope, kept as the event's own occurrence time.
 *
 * It is **no longer the ordering key** — Stripe stamps it to the second and
 * fires several events per subscription inside one second, so it cannot order
 * them. The ordering key is now the moment we read the subscription back
 * (`state_observed_at`). This is still worth parsing: it is what the stored
 * event means by "when did this happen", and invoice handling reports on it.
 */
function eventCreatedAt(stored: StoredStripeEvent): Date {
  const created = stored.payload['created']
  if (typeof created === 'number' && Number.isFinite(created)) return new Date(created * 1000)
  return stored.receivedAt
}

/** How many stored events one drain pass takes. Not a rules threshold; a batch size. */
export const DRAIN_BATCH_SIZE = 100

/**
 * The receiver answers 200 the moment the event is stored; this is the half
 * that does the work afterwards. Draining the table rather than trusting an
 * enqueue
 * means an event that was stored while the queue was unreachable is still
 * picked up on the next pass.
 */
export async function drainStripeEvents(
  deps: BillingWorkerDeps,
  options: { limit?: number } = {},
): Promise<readonly ProcessOutcome[]> {
  const run = () => drainOnce(deps, options)
  if (!deps.events.withDrainLock) return run()
  // Another drain is already working the same rows; this one has nothing to
  // add. Whatever it does not reach stays unprocessed for the next pass.
  return (await deps.events.withDrainLock(run)) ?? []
}

async function drainOnce(
  deps: BillingWorkerDeps,
  options: { limit?: number },
): Promise<readonly ProcessOutcome[]> {
  const batch = await deps.events.claimUnprocessed(options.limit ?? DRAIN_BATCH_SIZE)
  const outcomes: ProcessOutcome[] = []
  for (const stored of batch) {
    const outcome = await processStripeEvent(deps, stored)
    // `unresolved` is deliberately NOT marked processed. It means we could not
    // determine what the merchant is entitled to — a Stripe key pointed at the
    // wrong mode, or a customer whose account row has not landed yet. Closing
    // the event would destroy the only record that anything went wrong, and for
    // a merchant who has just paid that is money taken with no access and no
    // trace. Left open, the event is retried by the next drain and by the
    // nightly job, and stays visible as an unprocessed row.
    if (outcome.action !== 'unresolved') {
      await deps.events.markProcessed(stored.eventId)
    }
    outcomes.push(outcome)
  }
  return outcomes
}

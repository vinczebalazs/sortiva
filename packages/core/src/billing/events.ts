import { mapStripeStatus, type StripeEventEnvelope } from './provider'
import type { SubscriptionStatus } from './entitlement'

/**
 * Exactly the events we act on. Anything else Stripe sends is
 * stored (so the audit trail is complete) and then ignored — an unhandled type
 * must never fall through to a status write.
 */
export const HANDLED_EVENT_TYPES = [
  'checkout.session.completed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
  'invoice.paid',
] as const

export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number]

export interface SubscriptionSnapshot {
  readonly subscriptionId: string
  readonly customerId: string
  readonly status: SubscriptionStatus
  readonly priceId: string
  readonly currentPeriodEnd: Date | null
  readonly cancelAtPeriodEnd: boolean
}

export type BillingEvent =
  | {
      readonly kind: 'checkout_completed'
      readonly eventId: string
      readonly occurredAt: Date
      /** From `client_reference_id` — the account that started this Checkout. */
      readonly accountId: string | null
      readonly customerId: string | null
      readonly subscriptionId: string | null
    }
  | {
      /** The only kind of event that writes `subscriptions.status`. */
      readonly kind: 'subscription_state'
      readonly eventId: string
      readonly occurredAt: Date
      readonly deleted: boolean
      readonly subscription: SubscriptionSnapshot
    }
  | {
      readonly kind: 'invoice_outcome'
      readonly eventId: string
      readonly occurredAt: Date
      readonly failed: boolean
      readonly customerId: string | null
      readonly subscriptionId: string | null
    }
  | { readonly kind: 'ignored'; readonly eventId: string; readonly type: string }

function object(envelope: StripeEventEnvelope): Record<string, unknown> {
  const data = envelope.payload['data']
  if (data && typeof data === 'object') {
    const inner = (data as Record<string, unknown>)['object']
    if (inner && typeof inner === 'object') return inner as Record<string, unknown>
  }
  return {}
}

function str(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  if (typeof value === 'string') return value
  // Stripe expands ids into objects when the caller asked it to; take the id.
  if (value && typeof value === 'object') {
    const id = (value as Record<string, unknown>)['id']
    if (typeof id === 'string') return id
  }
  return null
}

function unixToDate(value: unknown): Date | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000) : null
}

function firstItem(subscription: Record<string, unknown>): Record<string, unknown> {
  const items = subscription['items']
  if (items && typeof items === 'object') {
    const data = (items as Record<string, unknown>)['data']
    if (Array.isArray(data) && data[0] && typeof data[0] === 'object') {
      return data[0] as Record<string, unknown>
    }
  }
  return {}
}

/**
 * The billing period moved from the subscription onto its items in Stripe's
 * 2025 API versions. Reading both means a key rotation or an API-version bump
 * cannot quietly null out the date the "ending" banner and the reconciliation
 * staleness both depend on.
 */
function periodEnd(subscription: Record<string, unknown>): Date | null {
  return (
    unixToDate(subscription['current_period_end']) ??
    unixToDate(firstItem(subscription)['current_period_end'])
  )
}

function priceId(subscription: Record<string, unknown>): string {
  const item = firstItem(subscription)
  const price = item['price']
  if (price && typeof price === 'object') {
    const id = (price as Record<string, unknown>)['id']
    if (typeof id === 'string') return id
  }
  return str(item, 'plan') ?? ''
}

/**
 * Turns a signature-verified envelope into the decision inputs. Pure: it never
 * asks Stripe for anything the payload did not carry, because that would be a
 * Stripe call inside webhook handling that invariant 16 has no room for.
 */
export function parseBillingEvent(envelope: StripeEventEnvelope): BillingEvent {
  const body = object(envelope)
  const base = { eventId: envelope.id, occurredAt: envelope.created } as const

  switch (envelope.type) {
    case 'checkout.session.completed':
      return {
        kind: 'checkout_completed',
        ...base,
        accountId: str(body, 'client_reference_id'),
        customerId: str(body, 'customer'),
        subscriptionId: str(body, 'subscription'),
      }

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscriptionId = str(body, 'id')
      const customerId = str(body, 'customer')
      if (!subscriptionId || !customerId) {
        return { kind: 'ignored', eventId: envelope.id, type: envelope.type }
      }
      const deleted = envelope.type === 'customer.subscription.deleted'
      return {
        kind: 'subscription_state',
        ...base,
        deleted,
        subscription: {
          subscriptionId,
          customerId,
          // A `.deleted` event carries the subscription as Stripe last saw it;
          // its `status` is already `canceled`, but the event type is the
          // stronger statement, so it wins.
          status: deleted ? 'canceled' : mapStripeStatus(String(body['status'] ?? '')),
          priceId: priceId(body),
          currentPeriodEnd: periodEnd(body),
          cancelAtPeriodEnd: body['cancel_at_period_end'] === true,
        },
      }
    }

    case 'invoice.payment_failed':
    case 'invoice.paid':
      return {
        kind: 'invoice_outcome',
        ...base,
        failed: envelope.type === 'invoice.payment_failed',
        customerId: str(body, 'customer'),
        subscriptionId: str(body, 'subscription') ?? str(body, 'parent'),
      }

    default:
      return { kind: 'ignored', eventId: envelope.id, type: envelope.type }
  }
}

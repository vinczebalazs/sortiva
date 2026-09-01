import type { LocalSubscription, SubscriptionStatus } from './entitlement'
import type {
  BillingStore,
  OrphanedCustomer,
  StaleSubscription,
  StoredStripeEvent,
  StripeEventStore,
  SubscriptionWrite,
  SubscriptionWriteResult,
} from './store'

/**
 * In-memory doubles for the two billing ports, in the T0.5 pattern: they
 * enforce the contract rather than record calls. `writeSubscription` applies
 * the same `state_observed_at` guard the SQL binding does, so a test that
 * proves a write carrying an older read is rejected here is proving the rule,
 * and the integration test proves the SQL implements it.
 *
 * Not exported from `billing/index.ts` — test surface, not product surface.
 */

interface StoredRow extends LocalSubscription {
  accountId: string
  stripeSubscriptionId: string
  priceId: string
  /** The staleness clock: when we last contacted Stripe about this row. */
  syncedAt: Date
  /** The ordering floor: when we read the state this row holds. */
  stateObservedAt: Date
}

export class InMemoryBillingStore implements BillingStore {
  readonly rows = new Map<string, StoredRow>()
  private readonly customers = new Map<string, string>()
  private readonly accounts = new Set<string>()

  seedAccount(accountId: string, customerId?: string): void {
    this.accounts.add(accountId)
    if (customerId) this.customers.set(customerId, accountId)
  }

  async findAccountIdByCustomerId(customerId: string): Promise<string | null> {
    return this.customers.get(customerId) ?? null
  }

  async accountExists(accountId: string): Promise<boolean> {
    return this.accounts.has(accountId)
  }

  async attachCustomer(accountId: string, customerId: string): Promise<void> {
    this.customers.set(customerId, accountId)
  }

  async writeSubscription(write: SubscriptionWrite): Promise<SubscriptionWriteResult> {
    const existing = this.rows.get(write.accountId)
    const previousStatus: SubscriptionStatus | null = existing?.status ?? null
    if (existing && existing.stateObservedAt.getTime() > write.stateObservedAt.getTime()) {
      return { applied: false, previousStatus }
    }
    this.rows.set(write.accountId, {
      accountId: write.accountId,
      stripeSubscriptionId: write.stripeSubscriptionId,
      priceId: write.priceId,
      status: write.status,
      currentPeriodEnd: write.currentPeriodEnd,
      cancelAtPeriodEnd: write.cancelAtPeriodEnd,
      syncedAt: maxDate(existing?.syncedAt, write.stateObservedAt),
      stateObservedAt: write.stateObservedAt,
    })
    return { applied: true, previousStatus }
  }

  async readSubscription(accountId: string): Promise<LocalSubscription | null> {
    const row = this.rows.get(accountId)
    if (!row) return null
    return {
      status: row.status,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      currentPeriodEnd: row.currentPeriodEnd,
    }
  }

  async staleSubscriptions(olderThan: Date, limit: number): Promise<readonly StaleSubscription[]> {
    return [...this.rows.values()]
      .filter((row) => row.syncedAt.getTime() <= olderThan.getTime())
      .sort((a, b) => a.syncedAt.getTime() - b.syncedAt.getTime())
      .slice(0, limit)
      .map((row) => ({
        accountId: row.accountId,
        stripeSubscriptionId: row.stripeSubscriptionId,
        syncedAt: row.syncedAt,
        stateObservedAt: row.stateObservedAt,
      }))
  }

  async orphanedCustomers(limit: number): Promise<readonly OrphanedCustomer[]> {
    return [...this.customers.entries()]
      .filter(([, accountId]) => !this.rows.has(accountId))
      .slice(0, limit)
      .map(([stripeCustomerId, accountId]) => ({ accountId, stripeCustomerId }))
  }

  async markSynced(accountId: string, syncedAt: Date): Promise<void> {
    const row = this.rows.get(accountId)
    if (row) row.syncedAt = maxDate(row.syncedAt, syncedAt)
  }
}

function maxDate(a: Date | undefined, b: Date): Date {
  return a && a.getTime() > b.getTime() ? a : b
}

export class InMemoryStripeEventStore implements StripeEventStore {
  readonly stored = new Map<string, StoredStripeEvent>()
  readonly processed = new Set<string>()

  async record(event: Omit<StoredStripeEvent, 'receivedAt'>): Promise<boolean> {
    if (this.stored.has(event.eventId)) return false
    this.stored.set(event.eventId, { ...event, receivedAt: new Date() })
    return true
  }

  async claimUnprocessed(limit: number): Promise<readonly StoredStripeEvent[]> {
    return [...this.stored.values()]
      .filter((event) => !this.processed.has(event.eventId))
      .sort((a, b) => createdOf(a) - createdOf(b))
      .slice(0, limit)
  }

  async markProcessed(eventId: string): Promise<void> {
    this.processed.add(eventId)
  }
}

function createdOf(event: StoredStripeEvent): number {
  const created = event.payload['created']
  return typeof created === 'number' ? created : event.receivedAt.getTime() / 1000
}

/** Builds the Stripe event shapes we handle, in Stripe's own JSON layout. */
export function stripeEventFixtures(options: {
  accountId: string
  customerId: string
  subscriptionId: string
  priceId: string
}) {
  const { accountId, customerId, subscriptionId, priceId } = options

  const subscriptionObject = (fields: {
    status: string
    cancelAtPeriodEnd?: boolean
    periodEnd?: number
  }) => ({
    id: subscriptionId,
    customer: customerId,
    status: fields.status,
    cancel_at_period_end: fields.cancelAtPeriodEnd ?? false,
    items: {
      data: [{ price: { id: priceId }, current_period_end: fields.periodEnd ?? 1_800_000_000 }],
    },
  })

  return {
    checkoutCompleted(eventId: string, created: number) {
      return {
        id: eventId,
        type: 'checkout.session.completed',
        created,
        data: {
          object: {
            id: 'cs_test_1',
            mode: 'subscription',
            client_reference_id: accountId,
            customer: customerId,
            subscription: subscriptionId,
          },
        },
      }
    },
    subscriptionUpdated(
      eventId: string,
      created: number,
      fields: { status: string; cancelAtPeriodEnd?: boolean; periodEnd?: number },
    ) {
      return {
        id: eventId,
        type: 'customer.subscription.updated',
        created,
        data: { object: subscriptionObject(fields) },
      }
    },
    subscriptionDeleted(eventId: string, created: number) {
      return {
        id: eventId,
        type: 'customer.subscription.deleted',
        created,
        data: { object: subscriptionObject({ status: 'canceled' }) },
      }
    },
    invoicePaymentFailed(eventId: string, created: number) {
      return {
        id: eventId,
        type: 'invoice.payment_failed',
        created,
        data: { object: { id: 'in_1', customer: customerId, subscription: subscriptionId } },
      }
    },
    invoicePaid(eventId: string, created: number) {
      return {
        id: eventId,
        type: 'invoice.paid',
        created,
        data: { object: { id: 'in_2', customer: customerId, subscription: subscriptionId } },
      }
    },
  }
}

import { and, eq, isNull, lte, sql } from 'drizzle-orm'
import { accountScope, db, schema, type Db } from '@sortiva/db'
// Deep import, not the package barrel: `@sortiva/jobs`'s index re-exports the
// Graphile Worker runtime, which would drag the worker library into every
// request bundle that touches this file. The lock module itself imports only
// `pg` types.
import { withAccountLock } from '@sortiva/jobs/runtime/lock'
import type {
  BillingStore,
  LocalSubscription,
  StaleSubscription,
  StoredStripeEvent,
  StripeEventStore,
  SubscriptionStatus,
  SubscriptionWrite,
  SubscriptionWriteResult,
} from '@sortiva/core'

/**
 * The composition root for billing persistence: where `packages/core`'s billing
 * ports meet Postgres. Core owns no persistence (constitution code-structure
 * rules), so — exactly as T1.1 bound the account port — the binding lives in
 * `apps/web`.
 *
 * These queries belong in `packages/db/src/repositories/billing.ts` alongside
 * every other repository. `packages/db` was held by another session for the
 * whole of T1.2 and could not be edited; moving them is a mechanical follow-up.
 * See DECISIONS 2026-08-31 T1.2.
 */

const { accounts, subscriptions, stripeEvents } = schema

/**
 * The `pg.Pool` the account lock needs, taken structurally from
 * `withAccountLock` so `apps/web` does not have to depend on `pg` directly.
 */
type LockPool = Parameters<typeof withAccountLock>[0]

export interface BillingStoreOptions {
  /** The integration test hands in its own isolated database and pool. */
  database?: Db
  pool?: LockPool
}

export function makeBillingStore(options: BillingStoreOptions = {}): BillingStore {
  const database = options.database ?? db()

  return {
    async findAccountIdByCustomerId(customerId: string): Promise<string | null> {
      const [row] = await database
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.stripeCustomerId, customerId), isNull(accounts.deletedAt)))
        .limit(1)
      return row?.id ?? null
    },

    async accountExists(accountId: string): Promise<boolean> {
      const [row] = await database
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.id, accountId), isNull(accounts.deletedAt)))
        .limit(1)
      return row !== undefined
    },

    async attachCustomer(accountId: string, customerId: string): Promise<void> {
      await database
        .update(accounts)
        .set({ stripeCustomerId: customerId })
        .where(eq(accounts.id, accountId))
    },

    async writeSubscription(write: SubscriptionWrite): Promise<SubscriptionWriteResult> {
      const run = async () => applyWrite(database, write)
      // Invariant 18 — all work for one account serialises. Read-then-guarded-
      // write is the only compound operation on this row, so the lock wraps
      // exactly it: two webhook deliveries for the same account cannot
      // interleave and report each other's previous status.
      return options.pool ? withAccountLock(options.pool, write.accountId, run) : run()
    },

    async readSubscription(accountId: string): Promise<LocalSubscription | null> {
      const scope = accountScope(accountId)
      const [row] = await database
        .select({
          status: subscriptions.status,
          cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
        })
        .from(subscriptions)
        .where(eq(subscriptions.accountId, scope.accountId))
        .limit(1)
      return row ?? null
    },

    async staleSubscriptions(olderThan: Date, limit: number): Promise<readonly StaleSubscription[]> {
      const rows = await database
        .select({
          accountId: subscriptions.accountId,
          stripeSubscriptionId: subscriptions.stripeSubscriptionId,
          syncedAt: subscriptions.syncedAt,
        })
        .from(subscriptions)
        .where(lte(subscriptions.syncedAt, olderThan))
        .orderBy(subscriptions.syncedAt)
        .limit(limit)
      return rows
    },
  }
}

/**
 * The guarded upsert. `synced_at` holds the **Stripe-side** time of the state
 * stored, so `WHERE synced_at <= EXCLUDED.synced_at` is what makes an
 * out-of-order or replayed delivery a no-op instead of a rollback — invariant
 * 15's guarded-transition discipline on the one table Stripe writes.
 */
async function applyWrite(database: Db, write: SubscriptionWrite): Promise<SubscriptionWriteResult> {
  const [existing] = await database
    .select({ status: subscriptions.status })
    .from(subscriptions)
    .where(eq(subscriptions.accountId, write.accountId))
    .limit(1)

  const result = await database.execute(sql`
    INSERT INTO subscriptions (
      account_id, stripe_subscription_id, price_id, status,
      current_period_end, cancel_at_period_end, synced_at
    ) VALUES (
      ${write.accountId}::uuid, ${write.stripeSubscriptionId}, ${write.priceId},
      ${write.status}::subscription_status, ${write.currentPeriodEnd},
      ${write.cancelAtPeriodEnd}, ${write.observedAt}
    )
    ON CONFLICT (account_id) DO UPDATE SET
      stripe_subscription_id = EXCLUDED.stripe_subscription_id,
      price_id               = EXCLUDED.price_id,
      status                 = EXCLUDED.status,
      current_period_end     = EXCLUDED.current_period_end,
      cancel_at_period_end   = EXCLUDED.cancel_at_period_end,
      synced_at              = EXCLUDED.synced_at
    WHERE subscriptions.synced_at <= EXCLUDED.synced_at
    RETURNING account_id
  `)

  return {
    applied: rowCount(result) > 0,
    previousStatus: (existing?.status as SubscriptionStatus | undefined) ?? null,
  }
}

function rowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length
  const rows = (result as { rows?: unknown[]; rowCount?: number | null }).rows
  if (Array.isArray(rows)) return rows.length
  return (result as { rowCount?: number | null }).rowCount ?? 0
}

/**
 * main §14.3.8, tech §3 — insert-or-ignore by Stripe's event id, then process
 * from the table. The table is the queue: an event stored while nothing was
 * draining is picked up by the next pass rather than lost with the request.
 */
export function makeStripeEventStore(options: BillingStoreOptions = {}): StripeEventStore {
  const database = options.database ?? db()

  return {
    async record(event): Promise<boolean> {
      const inserted = await database
        .insert(stripeEvents)
        .values({ eventId: event.eventId, type: event.type, payload: event.payload })
        .onConflictDoNothing()
        .returning({ eventId: stripeEvents.eventId })
      return inserted.length > 0
    },

    async claimUnprocessed(limit: number): Promise<readonly StoredStripeEvent[]> {
      // Ordered by Stripe's own `created`, not by our arrival time, so a burst
      // is applied in the order Stripe generated it. The write guard still
      // covers what ordering cannot.
      const result = await database.execute(sql`
        SELECT event_id, type, payload, received_at
        FROM stripe_events
        WHERE processed_at IS NULL
        ORDER BY COALESCE((payload->>'created')::bigint,
                          EXTRACT(EPOCH FROM received_at)::bigint) ASC,
                 event_id ASC
        LIMIT ${limit}
      `)
      return rowsOf(result).map((row) => ({
        eventId: String(row['event_id']),
        type: String(row['type']),
        payload: (row['payload'] ?? {}) as Record<string, unknown>,
        receivedAt: new Date(row['received_at'] as string),
      }))
    },

    async markProcessed(eventId: string): Promise<void> {
      await database
        .update(stripeEvents)
        .set({ processedAt: new Date() })
        .where(eq(stripeEvents.eventId, eventId))
    },
  }
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  const rows = (result as { rows?: unknown[] }).rows
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
}

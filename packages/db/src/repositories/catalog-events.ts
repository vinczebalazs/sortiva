import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { webhookEvents } from '../schema'
import type { SystemScope } from '../scope'

/**
 * The record of what a merchant changed in their store, and the queue of things
 * Shopify has told us that we have not yet acted on.
 *
 * Both live in `webhook_events`, which is the table the schema gives us for
 * "something arrived; deal with it later". Two kinds of row sit there, told
 * apart by topic:
 *
 *  - a **receipt**, keyed on Shopify's own `X-Shopify-Webhook-Id`. Written the
 *    instant a webhook is verified, before anything is decided, so answering
 *    Shopify inside their five-second budget never waits on our work and a
 *    redelivery is free.
 *  - a **change**, keyed on a fingerprint of the change itself. This is the
 *    stream the content inventory and the drift rules read. Two producers write
 *    it — a webhook we processed, and the nightly sweep that catches the ones
 *    Shopify dropped — and because the key is derived from the change rather
 *    than from the delivery, the same edit found twice is one row.
 *
 * The table has no account column, so the account travels inside the payload.
 * That is a real cost — reading one store's changes cannot use an index on the
 * account — and it is accepted rather than hidden: see DECISIONS 2026-09-02
 * `T2.2`.
 */

/** Topics we invent for our own rows, so a change is never mistaken for a receipt. */
const CHANGE_TOPIC_PREFIX = 'catalog_change/'

export type WebhookReceipt = typeof webhookEvents.$inferSelect

export interface CatalogChangeInput {
  readonly accountId: string
  readonly shopHandle: string
  readonly kind: string
  readonly entityId: string
  /** When the merchant made the change, as the store reported it — never arrival time. */
  readonly occurredAt: string
  readonly changedFields: readonly string[]
}

/**
 * The identity of a change, as opposed to the identity of a delivery.
 *
 * Derived from what changed and when, so the nightly sweep re-finding an edit a
 * webhook already reported writes nothing, and a sweep run twice converges.
 * Never random: a random key would make every re-detection a new row and the
 * consumers would re-read the same page for ever.
 */
export function catalogChangeId(input: CatalogChangeInput): string {
  return `${CHANGE_TOPIC_PREFIX}${input.accountId}:${input.kind}:${input.entityId}:${input.occurredAt}`
}

/**
 * Records a change, or does nothing because it is already recorded.
 *
 * Returns whether this call was the one that wrote it, which is what the sweep
 * counts to report how much drift it found.
 */
export async function recordCatalogChange(
  db: Db,
  _scope: SystemScope,
  input: CatalogChangeInput,
): Promise<boolean> {
  const [row] = await db
    .insert(webhookEvents)
    .values({
      webhookId: catalogChangeId(input),
      source: 'shopify',
      topic: `${CHANGE_TOPIC_PREFIX}${input.kind}`,
      payload: {
        account_id: input.accountId,
        shop_handle: input.shopHandle,
        kind: input.kind,
        entity_id: input.entityId,
        occurred_at: input.occurredAt,
        changed_fields: [...input.changedFields],
      },
      // A change is not work waiting to be done — it is a fact, already true.
      // Marking it processed keeps the unprocessed-receipts query pointed at
      // deliveries nobody has acted on yet.
      status: 'processed',
      processedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ webhookId: webhookEvents.webhookId })
  return row !== undefined
}

export async function recordCatalogChanges(
  db: Db,
  scope: SystemScope,
  inputs: readonly CatalogChangeInput[],
): Promise<number> {
  let written = 0
  for (const input of inputs) {
    if (await recordCatalogChange(db, scope, input)) written += 1
  }
  return written
}

/** One change, as the stream hands it to a consumer. */
export interface CatalogChangeRow {
  readonly accountId: string
  readonly kind: string
  readonly entityId: string
  readonly occurredAt: string
  readonly changedFields: readonly string[]
}

export interface CatalogChangePage {
  readonly changes: readonly CatalogChangeRow[]
  /** Where to resume. Opaque to the consumer, which hands it straight back. */
  readonly cursor: string
}

/**
 * One store's changes since the consumer last looked.
 *
 * Ordered by arrival and then by key, and the cursor carries both. Arrival time
 * alone is not enough: a sweep writes a hundred changes inside one transaction
 * and they all share a timestamp, so a cursor holding only the time would either
 * re-deliver the whole batch or skip most of it.
 */
export async function readCatalogChanges(
  db: Db,
  _scope: SystemScope,
  accountId: string,
  cursor: string | undefined,
  limit = 500,
): Promise<CatalogChangePage> {
  const after = decodeCursor(cursor)
  const rows = await db
    .select({
      webhookId: webhookEvents.webhookId,
      // Read as text, not as a `Date`. Postgres keeps microseconds and
      // JavaScript keeps milliseconds, so a cursor built from a parsed date
      // rounds down and hands the consumer its own last row again, for ever.
      receivedAt: sql<string>`${webhookEvents.receivedAt}::text`.as('received_text'),
      payload: webhookEvents.payload,
    })
    .from(webhookEvents)
    .where(
      and(
        sql`${webhookEvents.topic} like ${`${CHANGE_TOPIC_PREFIX}%`}`,
        sql`${webhookEvents.payload} ->> 'account_id' = ${accountId}`,
        after
          ? sql`(${webhookEvents.receivedAt}, ${webhookEvents.webhookId}) > (${after.receivedAt}::timestamptz, ${after.webhookId})`
          : sql`true`,
      ),
    )
    .orderBy(asc(webhookEvents.receivedAt), asc(webhookEvents.webhookId))
    .limit(limit)

  const changes = rows.map((row) => {
    const payload = row.payload as Record<string, unknown>
    return {
      accountId: String(payload['account_id'] ?? ''),
      kind: String(payload['kind'] ?? ''),
      entityId: String(payload['entity_id'] ?? ''),
      occurredAt: String(payload['occurred_at'] ?? row.receivedAt),
      changedFields: Array.isArray(payload['changed_fields'])
        ? (payload['changed_fields'] as string[])
        : [],
    }
  })

  const last = rows.at(-1)
  return {
    changes,
    cursor: last ? encodeCursor(last.receivedAt, last.webhookId) : (cursor ?? ''),
  }
}

function encodeCursor(receivedAt: string, webhookId: string): string {
  return `${receivedAt}|${webhookId}`
}

function decodeCursor(cursor: string | undefined): { receivedAt: string; webhookId: string } | undefined {
  if (!cursor) return undefined
  const split = cursor.indexOf('|')
  if (split <= 0) return undefined
  const receivedAt = cursor.slice(0, split)
  if (Number.isNaN(new Date(receivedAt).getTime())) return undefined
  return { receivedAt, webhookId: cursor.slice(split + 1) }
}

/**
 * Deliveries that have arrived and not yet been acted on, oldest first.
 *
 * Read from the table and never from a request body: that is what lets the
 * receiver answer Shopify immediately and lose nothing if the process dies
 * between answering and working.
 */
/**
 * How many times a delivery is tried before it is given up on. Shopify itself
 * retries a delivery we never answered; this is about the ones we answered and
 * then could not process — a store locked by its own nightly sync, a database
 * hiccup — which are worth a few attempts and not an unbounded number.
 */
export const MAX_WEBHOOK_ATTEMPTS = 5

export async function unprocessedWebhooks(
  db: Db,
  _scope: SystemScope,
  limit = 100,
): Promise<WebhookReceipt[]> {
  return db
    .select()
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.source, 'shopify'),
        isNull(webhookEvents.processedAt),
        sql`${webhookEvents.topic} not like ${`${CHANGE_TOPIC_PREFIX}%`}`,
      ),
    )
    .orderBy(asc(webhookEvents.receivedAt), asc(webhookEvents.webhookId))
    .limit(limit)
}

/**
 * Marks a delivery dealt with — or, for a failure, records what went wrong and
 * leaves it to be tried again.
 *
 * Guarded on the row still being unprocessed, so two workers handed the same
 * delivery cannot both claim to have finished it — whichever loses matches zero
 * rows and stops, exactly like every other transition in the product.
 *
 * A failure deliberately leaves the row unfinished. Stamping it as done was how
 * a delivery that arrived while the store's nightly sync held the lock — the
 * ordinary case, not a rare one — was recorded as failed and never looked at
 * again, so a merchant's product edit waited for the next night's re-read
 * instead of the next drain.
 */
export async function markWebhookProcessed(
  db: Db,
  _scope: SystemScope,
  webhookId: string,
  outcome: { status: 'processed' | 'ignored' | 'failed'; error?: string; attempts?: number },
  now: Date = new Date(),
): Promise<boolean> {
  const attempts = outcome.attempts ?? 0
  const [row] = await db
    .update(webhookEvents)
    .set({
      status: outcome.status,
      // A failure that has already been tried the maximum number of times is
      // finished with, whatever its state: a delivery nobody can process must
      // not be re-read on every drain for the thirty days before it is pruned.
      ...(outcome.status === 'failed' && attempts + 1 < MAX_WEBHOOK_ATTEMPTS
        ? { attempts: attempts + 1 }
        : { processedAt: now, attempts: attempts + 1 }),
      lastError: outcome.error ?? null,
    })
    .where(and(eq(webhookEvents.webhookId, webhookId), isNull(webhookEvents.processedAt)))
    .returning({ webhookId: webhookEvents.webhookId })
  return row !== undefined
}

import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { opsFlags, previewCache, requestCache, stripeEvents, webhookEvents } from '../schema'
import type { AccountScope, SystemScope } from '../scope'

export type WebhookEventRow = typeof webhookEvents.$inferSelect
export type StripeEventRow = typeof stripeEvents.$inferSelect
export type RequestCacheRow = typeof requestCache.$inferSelect
export type OpsFlagRow = typeof opsFlags.$inferSelect

/**
 * main §14.3.8 — "`webhook_events.webhook_id` is unique; insert-or-ignore, then
 * process from the table, never from the request body directly."
 *
 * Takes a `SystemScope`: the receiver has verified HMAC but not yet resolved
 * which account the event belongs to.
 */
export async function recordWebhookEvent(
  db: Db,
  _scope: SystemScope,
  input: {
    webhookId: string
    source: WebhookEventRow['source']
    topic: string
    payload: Record<string, unknown>
  },
): Promise<WebhookEventRow | undefined> {
  const [row] = await db.insert(webhookEvents).values(input).onConflictDoNothing().returning()
  return row
}

/** main §4.2, tech §3 — same pattern, keyed by Stripe's event id. */
export async function recordStripeEvent(
  db: Db,
  _scope: SystemScope,
  input: { eventId: string; type: string; payload: Record<string, unknown> },
): Promise<StripeEventRow | undefined> {
  const [row] = await db.insert(stripeEvents).values(input).onConflictDoNothing().returning()
  return row
}

/**
 * main §14.3.6, constitution invariant 20 — billable reads and LLM calls are
 * cached at request level and **written before processing**, so a crash after
 * the provider responded but before downstream work still replays from cache
 * and never re-bills.
 *
 * `putBeforeProcessing` therefore takes the raw response, not a processed
 * result, and is called immediately on receipt.
 */
export async function readCachedRequest(
  db: Db,
  _scope: SystemScope,
  cacheKey: string,
): Promise<RequestCacheRow | undefined> {
  const [row] = await db
    .select()
    .from(requestCache)
    .where(and(eq(requestCache.cacheKey, cacheKey), sql`${requestCache.expiresAt} > now()`))
    .limit(1)
  return row
}

export async function putBeforeProcessing(
  db: Db,
  _scope: SystemScope,
  input: {
    cacheKey: string
    kind: string
    responseJson: unknown
    expiresAt: Date
  },
): Promise<void> {
  await db
    .insert(requestCache)
    .values(input as typeof requestCache.$inferInsert)
    .onConflictDoUpdate({
      target: requestCache.cacheKey,
      set: { responseJson: input.responseJson as never, expiresAt: input.expiresAt },
    })
}

/** main §3.2, invariant 2 — disposable. Nothing downstream of ingestion reads this. */
export async function readPreviewCache(db: Db, _scope: SystemScope, domainNormalized: string) {
  const [row] = await db
    .select()
    .from(previewCache)
    .where(
      and(
        eq(previewCache.domainNormalized, domainNormalized),
        sql`${previewCache.expiresAt} > now()`,
      ),
    )
    .limit(1)
  return row
}

/**
 * main §14.5, invariant 17 — kill switches are read from our DB at job dequeue.
 * PostHog observes trips; it never causes or gates them.
 */
export async function isGlobalFlagActive(
  db: Db,
  _scope: SystemScope,
  flag: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: opsFlags.id })
    .from(opsFlags)
    .where(and(eq(opsFlags.scope, 'global'), eq(opsFlags.flag, flag), isNull(opsFlags.resetAt)))
    .limit(1)
  return row !== undefined
}

export async function isAccountFlagActive(
  db: Db,
  scope: AccountScope,
  flag: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: opsFlags.id })
    .from(opsFlags)
    .where(
      and(
        eq(opsFlags.scope, 'account'),
        eq(opsFlags.accountId, scope.accountId),
        eq(opsFlags.flag, flag),
        isNull(opsFlags.resetAt),
      ),
    )
    .limit(1)
  return row !== undefined
}

/**
 * main §14.5 — "every flip is logged with actor + reason"; auto-trips never
 * auto-reset. Returns undefined when the flag is already active: the partial
 * unique index makes a second trip a no-op rather than a duplicate incident.
 */
export async function tripAccountFlag(
  db: Db,
  scope: AccountScope,
  input: { flag: string; actor: string; reason: string; trippedBy: OpsFlagRow['trippedBy'] },
): Promise<OpsFlagRow | undefined> {
  const [row] = await db
    .insert(opsFlags)
    .values({ scope: 'account', accountId: scope.accountId, ...input })
    .onConflictDoNothing()
    .returning()
  return row
}

/**
 * The same trip, for the switches whose blast radius is everyone: the vendor
 * bill a global cap protects is one bill, not one per store.
 *
 * Returns undefined when the flag is already active — the partial unique index
 * makes a repeated trip a no-op, so a sweep that runs every few minutes while
 * the condition persists raises one flag and not a queue of them. Nothing here
 * ever resets a flag: an automatic trip means a human has to look.
 */
export async function tripGlobalFlag(
  db: Db,
  _scope: SystemScope,
  input: { flag: string; actor: string; reason: string; trippedBy: OpsFlagRow['trippedBy'] },
): Promise<OpsFlagRow | undefined> {
  const [row] = await db
    .insert(opsFlags)
    .values({ scope: 'global', accountId: null, ...input })
    .onConflictDoNothing()
    .returning()
  return row
}

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Db } from '../client'
import {
  incidentFindings,
  opsFlags,
  previewCache,
  requestCache,
  stripeEvents,
  webhookEvents,
} from '../schema'
import type { AccountScope, SystemScope } from '../scope'

export type WebhookEventRow = typeof webhookEvents.$inferSelect
export type StripeEventRow = typeof stripeEvents.$inferSelect
export type RequestCacheRow = typeof requestCache.$inferSelect
export type OpsFlagRow = typeof opsFlags.$inferSelect
export type IncidentFindingRow = typeof incidentFindings.$inferSelect

/**
 * `webhook_events.webhook_id` is unique: insert-or-ignore, then process from
 * the table and never from the request body, so a redelivery is free and the
 * receiver can answer immediately.
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

/** The same pattern, keyed by Stripe's event id. */
export async function recordStripeEvent(
  db: Db,
  _scope: SystemScope,
  input: { eventId: string; type: string; payload: Record<string, unknown> },
): Promise<StripeEventRow | undefined> {
  const [row] = await db.insert(stripeEvents).values(input).onConflictDoNothing().returning()
  return row
}

/**
 * Billable reads and LLM calls are cached at request level and **written
 * before processing**, so a crash after the vendor answered but before we
 * finished with the answer replays from cache rather than buying it again.
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

/** Disposable: nothing downstream of ingestion reads the preview cache. */
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
 * Kill switches are read from our own database at job dequeue. Analytics
 * observes a trip; it never causes or gates one, because a switch has to work
 * when that vendor does not.
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
 * Every flip is recorded with who did it and why. Returns undefined when the
 * flag is already active: the partial unique index makes a second trip a no-op
 * rather than a duplicate incident.
 *
 * Almost nothing lowers a switch on its own — an automatic trip means somebody
 * has to look at why it fired. The exception is the two per-store daily
 * allowances, which the auto-trip sweep takes back down once the day they were
 * about has passed.
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

/**
 * Lowering a switch. The caller has already had the decision reviewed
 * (`reviewReset` in `packages/core`) and passes the name — or names — that
 * review produced; this only writes it.
 *
 * Guarded on `reset_at IS NULL`, so two operators racing to lower the same
 * switch produce one lowering and one "already down" rather than overwriting
 * each other's record of who agreed. Returns undefined when the switch was not
 * up.
 */
export async function resetGlobalFlag(
  db: Db,
  _scope: SystemScope,
  input: { flag: string; resetBy: string },
): Promise<OpsFlagRow | undefined> {
  const [row] = await db
    .update(opsFlags)
    .set({ resetAt: sql`now()`, resetBy: input.resetBy })
    .where(
      and(eq(opsFlags.scope, 'global'), eq(opsFlags.flag, input.flag), isNull(opsFlags.resetAt)),
    )
    .returning()
  return row
}

/** The same, for a switch raised about one store. */
export async function resetAccountFlag(
  db: Db,
  scope: AccountScope,
  input: { flag: string; resetBy: string },
): Promise<OpsFlagRow | undefined> {
  const [row] = await db
    .update(opsFlags)
    .set({ resetAt: sql`now()`, resetBy: input.resetBy })
    .where(
      and(
        eq(opsFlags.scope, 'account'),
        eq(opsFlags.accountId, scope.accountId),
        eq(opsFlags.flag, input.flag),
        isNull(opsFlags.resetAt),
      ),
    )
    .returning()
  return row
}

/**
 * Every switch that is currently up, newest first — the open-incident list.
 *
 * There is no incidents table: an open incident *is* an active flag whose
 * `tripped_by` is `auto`. Manual flags come back in the same list because an
 * operator wants one answer to "what is stopped right now", not two.
 *
 * The auto-trip sweep also reads this to find the per-store daily allowances it
 * raised, which are the one kind of trip that comes back down on its own.
 */
export async function listActiveFlags(db: Db, _scope: SystemScope): Promise<OpsFlagRow[]> {
  return db
    .select()
    .from(opsFlags)
    .where(isNull(opsFlags.resetAt))
    .orderBy(sql`${opsFlags.createdAt} DESC`)
}

/**
 * One incident by its id, open or closed.
 *
 * Lowering a switch is an update on this row, not a delete and not a fresh
 * insert, so the id an operator was given while the incident was open still
 * names it afterwards. That is what lets a finding arrive days late.
 */
export async function findFlagById(
  db: Db,
  _scope: SystemScope,
  id: string,
): Promise<OpsFlagRow | undefined> {
  const [row] = await db.select().from(opsFlags).where(eq(opsFlags.id, id)).limit(1)
  return row
}

/** The global switch of this name that is up right now, if one is. */
export async function findActiveGlobalFlag(
  db: Db,
  _scope: SystemScope,
  flag: string,
): Promise<OpsFlagRow | undefined> {
  const [row] = await db
    .select()
    .from(opsFlags)
    .where(and(eq(opsFlags.scope, 'global'), eq(opsFlags.flag, flag), isNull(opsFlags.resetAt)))
    .limit(1)
  return row
}

/** The same, for a switch raised about one store. */
export async function findActiveAccountFlag(
  db: Db,
  scope: AccountScope,
  flag: string,
): Promise<OpsFlagRow | undefined> {
  const [row] = await db
    .select()
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
  return row
}

/**
 * Incidents newest-raised first, **including the ones already closed** —
 * `listActiveFlags` deliberately shows only what is stopped right now, and an
 * investigation that finishes after the switch came back down has to be able
 * to find what it was about.
 *
 * Each trip of the same switch is its own row: the unique indexes cover only
 * active rows, so raising a flag that was lowered last week inserts a second
 * incident rather than reopening the first. Findings therefore stay attached
 * to the occasion they explain and not to the switch's name.
 */
export async function listRecentFlags(
  db: Db,
  _scope: SystemScope,
  filter: { flag?: string | undefined; accountId?: string | undefined; limit: number },
): Promise<OpsFlagRow[]> {
  const conditions = [
    ...(filter.flag ? [eq(opsFlags.flag, filter.flag)] : []),
    ...(filter.accountId ? [eq(opsFlags.accountId, filter.accountId)] : []),
  ]
  const query = db.select().from(opsFlags)
  return (conditions.length > 0 ? query.where(and(...conditions)) : query)
    .orderBy(desc(opsFlags.createdAt))
    .limit(filter.limit)
}

/**
 * What an operator found when they looked into a trip.
 *
 * The caller has already had the note reviewed (`reviewFinding` in
 * `packages/core`) and passes the name it produced; this only writes it. A
 * closed incident still accepts notes — the trip and the explanation are
 * separated by however long the investigation took, which is the whole reason
 * this is not a column on the flag row.
 *
 * Takes a `SystemScope` for the same reason the switches do: an incident about
 * one store is still an operations record about the product, read by the
 * people running it and never by a merchant.
 */
export async function addIncidentFinding(
  db: Db,
  _scope: SystemScope,
  input: { opsFlagId: string; author: string; finding: string },
): Promise<IncidentFindingRow> {
  const [row] = await db.insert(incidentFindings).values(input).returning()
  return row!
}

/** One incident's findings, oldest first: an investigation reads forwards. */
export async function listIncidentFindings(
  db: Db,
  _scope: SystemScope,
  opsFlagId: string,
): Promise<IncidentFindingRow[]> {
  return db
    .select()
    .from(incidentFindings)
    .where(eq(incidentFindings.opsFlagId, opsFlagId))
    .orderBy(asc(incidentFindings.createdAt))
}

/**
 * The findings for a list of incidents in one read, so printing a dozen
 * incidents with their notes is two queries rather than thirteen.
 */
export async function listFindingsForFlags(
  db: Db,
  _scope: SystemScope,
  opsFlagIds: readonly string[],
): Promise<Map<string, IncidentFindingRow[]>> {
  const byFlag = new Map<string, IncidentFindingRow[]>()
  if (opsFlagIds.length === 0) return byFlag
  const rows = await db
    .select()
    .from(incidentFindings)
    .where(inArray(incidentFindings.opsFlagId, [...opsFlagIds]))
    .orderBy(asc(incidentFindings.createdAt))
  for (const row of rows) {
    const existing = byFlag.get(row.opsFlagId)
    if (existing) existing.push(row)
    else byFlag.set(row.opsFlagId, [row])
  }
  return byFlag
}

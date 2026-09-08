import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { Db } from '../client'
import {
  emailSends,
  notifications,
  opportunities,
  opportunityTasks,
  optimizeRecommendations,
} from '../schema'
import type { AccountScope } from '../scope'

export type NotificationRow = typeof notifications.$inferSelect
export type NotificationType = NotificationRow['type']
export type EmailSendRow = typeof emailSends.$inferSelect

/**
 * What a notification says is written once and never rewritten. A unique
 * `(account_id, type, dedupe_key)` is what makes that safe under retries:
 * workers that may run twice attempt duplicate inserts, and the constraint
 * makes the second a no-op, so a retried publish job does not ring the bell
 * twice.
 *
 * Two things below do write to an existing row, and both leave every word of
 * it alone: the bell's seen/read timestamps, which are facts about the reader,
 * and the retention sweep in `lifecycle.ts`, which removes rows past the
 * window. `notifications-append-only.test.ts` beside this file is what stops a
 * third appearing — and says what it cannot see.
 *
 * Returns the row on first write and `undefined` when the notification already
 * existed, so callers can tell "emitted" from "already emitted" without a
 * separate read.
 */
export async function emitNotification(
  db: Db,
  scope: AccountScope,
  input: {
    type: NotificationType
    dedupeKey: string
    /** References only. Never display text, so a copy fix never rewrites stored rows. */
    payload?: Record<string, unknown>
  },
): Promise<NotificationRow | undefined> {
  const [row] = await db
    .insert(notifications)
    .values({
      accountId: scope.accountId,
      type: input.type,
      dedupeKey: input.dedupeKey,
      payloadJson: input.payload ?? {},
    })
    .onConflictDoNothing()
    .returning()
  return row
}

/**
 * The one notification behind an email, found by the triple both rows share.
 *
 * The email row carries only the type and the dedupe key; the references — which
 * article, which run — are on the notification. Looking them up here is what
 * lets an email name the thing it is about without the email row storing words.
 */
export async function findNotification(
  db: Db,
  scope: AccountScope,
  type: NotificationType,
  dedupeKey: string,
): Promise<NotificationRow | undefined> {
  const [row] = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.accountId, scope.accountId),
        eq(notifications.type, type),
        eq(notifications.dedupeKey, dedupeKey),
      ),
    )
    .limit(1)
  return row
}

/**
 * The bell's poll, every thirty seconds. `since` is the timestamp of the newest
 * item the browser already holds, so the common case — nothing new — returns an
 * empty list.
 *
 * The comparison truncates to milliseconds on both sides. Postgres keeps
 * microseconds and JavaScript cannot represent them, so a timestamp that has
 * been out to a browser and back is a rounded-down copy of the stored one — and
 * a plain `>` would therefore hand the client back the very row it used as its
 * mark, every single poll.
 *
 * Polling rather than a socket is deliberate: the freshest thing in this
 * product moves once a day, so half a minute of staleness on a badge is
 * invisible and there is no realtime infrastructure to run.
 */
export async function listNotifications(
  db: Db,
  scope: AccountScope,
  options: { since?: Date; limit?: number } = {},
): Promise<NotificationRow[]> {
  const scoped = eq(notifications.accountId, scope.accountId)
  const since = options.since
  return db
    .select()
    .from(notifications)
    .where(
      since
        ? and(
            scoped,
            sql`date_trunc('milliseconds', ${notifications.createdAt}) > ${since.toISOString()}::timestamptz`,
          )
        : scoped,
    )
    .orderBy(desc(notifications.createdAt))
    .limit(options.limit ?? 50)
}

/**
 * Opening the bell clears the badge. Only rows already unseen are touched, so
 * re-opening it does not rewrite history, and `read_at` is left alone — seen is
 * "you know it is there", read is "you clicked it".
 */
export async function markNotificationsSeen(
  db: Db,
  scope: AccountScope,
  at: Date = new Date(),
): Promise<number> {
  const updated = await db
    .update(notifications)
    .set({ seenAt: at })
    .where(and(eq(notifications.accountId, scope.accountId), isNull(notifications.seenAt)))
    .returning({ id: notifications.id })
  return updated.length
}

/** Returns false when the id is not this account's, which is also how a stale bell is answered. */
export async function markNotificationRead(
  db: Db,
  scope: AccountScope,
  notificationId: string,
  at: Date = new Date(),
): Promise<boolean> {
  const updated = await db
    .update(notifications)
    .set({ readAt: at, seenAt: sql`coalesce(${notifications.seenAt}, ${at.toISOString()}::timestamptz)` })
    .where(and(eq(notifications.accountId, scope.accountId), eq(notifications.id, notificationId)))
    .returning({ id: notifications.id })
  return updated.length > 0
}

export async function countUnseenNotifications(db: Db, scope: AccountScope): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.accountId, scope.accountId), isNull(notifications.seenAt)))
  return row?.n ?? 0
}

/**
 * The same triple, and the same send-once guarantee. The send worker drains
 * queued rows; this only enqueues.
 */
export async function queueEmail(
  db: Db,
  scope: AccountScope,
  input: {
    type: NotificationType
    dedupeKey: string
    templateVersion: string
    /**
     * `suppressed` is written straight away for an address that has bounced or
     * complained: the row is the record that we decided not to mail, which is
     * the answer to "why did I never get that".
     */
    state?: EmailSendRow['state']
  },
): Promise<EmailSendRow | undefined> {
  const [row] = await db
    .insert(emailSends)
    .values({
      accountId: scope.accountId,
      type: input.type,
      dedupeKey: input.dedupeKey,
      templateVersion: input.templateVersion,
      ...(input.state ? { state: input.state } : {}),
    })
    .onConflictDoNothing()
    .returning()
  return row
}

/**
 * What the dashboard's attention list is made of. Every function below is a
 * read; nothing here writes, and nothing here is stored. The item exists for
 * exactly as long as the condition does, which is why applying a task or
 * confirming a URL makes it disappear with no bookkeeping.
 */
export interface AttentionRow {
  readonly refs: Record<string, string>
  readonly since: Date
}

/**
 * Opportunities the engine could not act on by itself: it needs the merchant to
 * supply something about a product first. Open tasks only, and only on
 * opportunities that are still live — a dismissed opportunity's tasks stop
 * being anybody's problem.
 */
export async function openMerchantTasks(db: Db, scope: AccountScope): Promise<AttentionRow[]> {
  const rows = await db
    .select({
      opportunityId: opportunities.id,
      taskId: opportunityTasks.id,
      since: opportunities.detectedAt,
    })
    .from(opportunityTasks)
    .innerJoin(opportunities, eq(opportunityTasks.opportunityId, opportunities.id))
    .where(
      and(
        eq(opportunities.accountId, scope.accountId),
        eq(opportunities.recommendedAction, 'hold'),
        eq(opportunityTasks.state, 'open'),
        inArray(opportunities.status, ['new', 'accepted', 'scheduled', 'executing', 'blocked']),
      ),
    )
  return rows.map((row) => ({
    refs: { opportunity_id: row.opportunityId, task_id: row.taskId },
    since: row.since,
  }))
}

/**
 * Advice we generated that the merchant has not told us they used. A soft nudge
 * rather than a demand — nothing is wrong, they may simply not have got to it —
 * so it only appears once a recommendation is well past new.
 *
 * `generatedBefore` is the caller's cutoff, computed from the window in
 * `packages/core`'s attention module, so the number lives in one place.
 */
export async function unappliedOptimizeRecommendations(
  db: Db,
  scope: AccountScope,
  generatedBefore: Date,
): Promise<AttentionRow[]> {
  const rows = await db
    .select({
      opportunityId: opportunities.id,
      recommendationId: optimizeRecommendations.id,
      since: optimizeRecommendations.generatedAt,
    })
    .from(optimizeRecommendations)
    .innerJoin(opportunities, eq(optimizeRecommendations.opportunityId, opportunities.id))
    .where(
      and(
        eq(opportunities.accountId, scope.accountId),
        eq(optimizeRecommendations.state, 'valid'),
        isNull(opportunities.appliedAt),
        lt(optimizeRecommendations.generatedAt, generatedBefore),
      ),
    )
  return rows.map((row) => ({
    refs: { opportunity_id: row.opportunityId, recommendation_id: row.recommendationId },
    since: row.since,
  }))
}

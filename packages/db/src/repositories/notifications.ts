import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { emailSends, notifications } from '../schema'
import type { AccountScope } from '../scope'

export type NotificationRow = typeof notifications.$inferSelect
export type NotificationType = NotificationRow['type']
export type EmailSendRow = typeof emailSends.$inferSelect

/**
 * tech §1.2, constitution invariant 26 — append-only records with a unique
 * `(account_id, type, dedupe_key)`. At-least-once workers may attempt duplicate
 * inserts; the constraint makes the second a no-op, which is what stops a
 * retried publish job ringing the bell twice.
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
    /** tech §1.2 — references only. Never display text. */
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

/** tech §1.6 — the bell's poll: unseen count + recent items. */
export async function listNotifications(
  db: Db,
  scope: AccountScope,
  limit = 50,
): Promise<NotificationRow[]> {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.accountId, scope.accountId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
}

export async function countUnseenNotifications(db: Db, scope: AccountScope): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.accountId, scope.accountId), isNull(notifications.seenAt)))
  return row?.n ?? 0
}

/**
 * tech §1.4, invariant 26 — the same triple, and the same exactly-once
 * guarantee. The send worker drains queued rows; this only enqueues.
 */
export async function queueEmail(
  db: Db,
  scope: AccountScope,
  input: { type: NotificationType; dedupeKey: string; templateVersion: string },
): Promise<EmailSendRow | undefined> {
  const [row] = await db
    .insert(emailSends)
    .values({
      accountId: scope.accountId,
      type: input.type,
      dedupeKey: input.dedupeKey,
      templateVersion: input.templateVersion,
    })
    .onConflictDoNothing()
    .returning()
  return row
}

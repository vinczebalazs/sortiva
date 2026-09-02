import { and, asc, count, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import type { Db } from '../client'
import {
  accounts,
  emailSends,
  emailSuppressions,
  notificationPrefs,
  opportunities,
  opportunityTasks,
  optimizeRecommendations,
} from '../schema'
import type { AccountScope, SystemScope } from '../scope'
import type { EmailSendRow } from './notifications'

export type EmailSuppressionRow = typeof emailSuppressions.$inferSelect
export type NotificationPrefsRow = typeof notificationPrefs.$inferSelect

/**
 * Reads and writes for the email pipeline. `email_sends` is scoped by account
 * like everything else; the suppression list is not, and cannot be — an address
 * that bounced stays suppressed whichever account next tries to reach it, and
 * the same address may belong to none of them by then.
 */

/** One row, this account's. */
export async function getEmailSend(
  db: Db,
  scope: AccountScope,
  id: string,
): Promise<EmailSendRow | undefined> {
  const [row] = await db
    .select()
    .from(emailSends)
    .where(and(eq(emailSends.accountId, scope.accountId), eq(emailSends.id, id)))
    .limit(1)
  return row
}

/**
 * One row by id, without an account scope, because the send worker is handed a
 * row id by a queue message and the account is on the row. Every write that
 * follows is scoped by the account this read returns.
 */
export async function findEmailSend(
  db: Db,
  _scope: SystemScope,
  id: string,
): Promise<EmailSendRow | undefined> {
  const [row] = await db.select().from(emailSends).where(eq(emailSends.id, id)).limit(1)
  return row
}

/**
 * The drain's queue, oldest first, across every account — which is why it takes
 * a system scope. The rows it returns are handed back one at a time to code
 * that does hold an account scope.
 */
export async function listQueuedEmailSends(
  db: Db,
  _scope: SystemScope,
  limit = 100,
): Promise<EmailSendRow[]> {
  return db
    .select()
    .from(emailSends)
    .where(eq(emailSends.state, 'queued'))
    .orderBy(asc(emailSends.queuedAt))
    .limit(limit)
}

/**
 * Settling a send is a guarded update: it only moves a row that is still
 * `queued`. Two workers racing over the same row produce one winner, and the
 * loser is told it lost by getting `false` rather than by overwriting a state
 * somebody else already reached.
 */
async function settle(
  db: Db,
  scope: AccountScope,
  id: string,
  values: Partial<typeof emailSends.$inferInsert>,
): Promise<boolean> {
  const updated = await db
    .update(emailSends)
    .set(values)
    .where(
      and(
        eq(emailSends.accountId, scope.accountId),
        eq(emailSends.id, id),
        eq(emailSends.state, 'queued'),
      ),
    )
    .returning({ id: emailSends.id })
  return updated.length > 0
}

export function markEmailSent(
  db: Db,
  scope: AccountScope,
  id: string,
  providerMessageId: string,
  at: Date = new Date(),
): Promise<boolean> {
  return settle(db, scope, id, { state: 'sent', providerMessageId, sentAt: at })
}

export function markEmailFailed(
  db: Db,
  scope: AccountScope,
  id: string,
  lastError: string,
): Promise<boolean> {
  return settle(db, scope, id, { state: 'failed', lastError })
}

export function markEmailSuppressed(db: Db, scope: AccountScope, id: string): Promise<boolean> {
  return settle(db, scope, id, { state: 'suppressed' })
}

/** The address the account signs in with, which is the address we mail. */
export async function accountEmailAddress(
  db: Db,
  scope: AccountScope,
): Promise<string | undefined> {
  const [row] = await db
    .select({ email: accounts.email })
    .from(accounts)
    .where(eq(accounts.id, scope.accountId))
    .limit(1)
  return row?.email
}

export async function isEmailSuppressed(
  db: Db,
  _scope: SystemScope,
  address: string,
): Promise<boolean> {
  const [row] = await db
    .select({ email: emailSuppressions.email })
    .from(emailSuppressions)
    .where(eq(emailSuppressions.email, address))
    .limit(1)
  return row !== undefined
}

/**
 * Bounces and complaints arrive from the provider's webhook, which redelivers.
 * Insert-or-ignore keeps the first reason: an address that bounced and was
 * later reported as spam is already suppressed either way, and the earlier
 * reason is the more diagnostic one.
 */
export async function suppressEmailAddress(
  db: Db,
  _scope: SystemScope,
  address: string,
  reason: EmailSuppressionRow['reason'],
): Promise<void> {
  await db
    .insert(emailSuppressions)
    .values({ email: address, reason })
    .onConflictDoNothing()
}

export async function readNotificationPrefs(
  db: Db,
  scope: AccountScope,
): Promise<NotificationPrefsRow | undefined> {
  const [row] = await db
    .select()
    .from(notificationPrefs)
    .where(eq(notificationPrefs.accountId, scope.accountId))
    .limit(1)
  return row
}

/**
 * Both columns, always.
 *
 * One-click unsubscribe writes this row for a merchant who has never opened
 * Settings, and a partial write would take the other column's database default
 * — switching off something they never touched. Stating both makes that
 * impossible rather than unlikely; the caller supplies the untouched value from
 * the matrix defaults.
 */
export async function saveNotificationPrefs(
  db: Db,
  scope: AccountScope,
  prefs: {
    emailArticlePublished: boolean
    emailDigestFrequency: NotificationPrefsRow['emailDigestFrequency']
  },
  at: Date = new Date(),
): Promise<void> {
  await db
    .insert(notificationPrefs)
    .values({ accountId: scope.accountId, ...prefs, updatedAt: at })
    .onConflictDoUpdate({
      target: notificationPrefs.accountId,
      set: { ...prefs, updatedAt: at },
    })
}

/**
 * What the monthly summary can say about opportunities. Counts, not sentences:
 * the words are chosen in `packages/core` and live in the string catalogue.
 *
 * The other half of the summary — articles published and topics the quality bar
 * held back — needs the `articles` and `gate_decisions` tables, which schema
 * wave 3 creates. The job declares that gap as a wired stub rather than
 * reporting a quiet zero.
 */
export interface OpportunityMonthFacts {
  readonly optimizeRecommendationsGenerated: number
  readonly optimizeRecommendationsApplied: number
  readonly merchantTasksResolved: number
  readonly openOpportunityCount: number
  readonly topOpportunities: readonly {
    readonly action: string
    readonly entityRef: string
  }[]
}

const OPEN_STATUSES = ['new', 'accepted', 'scheduled', 'executing', 'blocked'] as const

export async function opportunityMonthFacts(
  db: Db,
  scope: AccountScope,
  window: { from: Date; to: Date },
  topN = 3,
): Promise<OpportunityMonthFacts> {
  const inWindow = (column: Parameters<typeof gte>[0]) =>
    and(gte(column, window.from), lt(column, window.to))

  const [[generated], [applied], [tasks]] = await Promise.all([
    db
      .select({ n: count() })
      .from(optimizeRecommendations)
      .innerJoin(opportunities, eq(optimizeRecommendations.opportunityId, opportunities.id))
      .where(
        and(
          eq(opportunities.accountId, scope.accountId),
          inWindow(optimizeRecommendations.generatedAt),
        ),
      ),
    db
      .select({ n: count() })
      .from(opportunities)
      .where(
        and(
          eq(opportunities.accountId, scope.accountId),
          eq(opportunities.recommendedAction, 'optimize'),
          sql`${opportunities.appliedAt} is not null`,
          inWindow(opportunities.appliedAt),
        ),
      ),
    db
      .select({ n: count() })
      .from(opportunityTasks)
      .innerJoin(opportunities, eq(opportunityTasks.opportunityId, opportunities.id))
      .where(
        and(
          eq(opportunities.accountId, scope.accountId),
          eq(opportunityTasks.state, 'applied'),
          sql`${opportunityTasks.appliedAt} is not null`,
          inWindow(opportunityTasks.appliedAt),
        ),
      ),
  ])

  const open = await db
    .select({
      action: opportunities.recommendedAction,
      entityRef: opportunities.entityRef,
      impactScore: opportunities.impactScore,
    })
    .from(opportunities)
    .where(
      and(
        eq(opportunities.accountId, scope.accountId),
        inArray(opportunities.status, [...OPEN_STATUSES]),
      ),
    )
    .orderBy(sql`${opportunities.impactScore} desc, ${opportunities.confidence} desc`)

  return {
    optimizeRecommendationsGenerated: generated?.n ?? 0,
    optimizeRecommendationsApplied: applied?.n ?? 0,
    merchantTasksResolved: tasks?.n ?? 0,
    openOpportunityCount: open.length,
    topOpportunities: open
      .slice(0, topN)
      .map((row) => ({ action: row.action, entityRef: row.entityRef })),
  }
}

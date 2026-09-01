import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { accounts } from './accounts'
import {
  emailDigestFrequencyEnum,
  emailSendStateEnum,
  emailSuppressionReasonEnum,
  notificationTypeEnum,
} from './enums'

/**
 * The bell: append-only records written the moment the event happens, inside
 * the same transaction as the state change where there is one. Attention items
 * are deliberately **not** here — those are live queries over current state, so
 * they cannot linger after the thing they were about is resolved.
 *
 * `payload_json` holds **references only** (topic_id, article_id, ...), so copy
 * fixes and localisation never touch stored rows and a deleted referent renders
 * a graceful generic line.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    type: notificationTypeEnum('type').notNull(),
    /**
     * Type-specific: article_id for publishes, topic_id for gate
     * holds, opportunity_id for recommendations, ISO week for weekly scans,
     * date for summaries. Not nullable: every type must name its dedupe key,
     * which is what makes the unique index below the exactly-once guarantee
     * under at-least-once workers.
     */
    dedupeKey: text('dedupe_key').notNull(),
    payloadJson: jsonb('payload_json').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Two different things: the badge clears when the bell is opened, an item
    // is read when it is clicked.
    seenAt: timestamp('seen_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [
    // Invariant 26 — a retried publish job cannot ring the bell twice.
    uniqueIndex('notifications_account_type_dedupe_key').on(t.accountId, t.type, t.dedupeKey),
    // Serves the bell's own query: the unseen count plus the recent items.
    index('notifications_account_created_at_idx').on(t.accountId, t.createdAt),
    index('notifications_account_unseen_idx')
      .on(t.accountId)
      .where(sql`${t.seenAt} IS NULL`),
    // The retention sweep prunes these at 90 days.
    index('notifications_created_at_idx').on(t.createdAt),
  ],
)

/**
 * The email pipeline. The unique index is what makes a retried worker send once
 * rather than twice, and the same triple goes to the mail provider as its
 * idempotency key so their side dedupes too.
 */
export const emailSends = pgTable(
  'email_sends',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    type: notificationTypeEnum('type').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    // Stamped on every send, so a complaint about an email can be traced to the
    // exact template that produced it.
    templateVersion: text('template_version').notNull(),
    state: emailSendStateEnum('state').notNull().default('queued'),
    providerMessageId: text('provider_message_id'),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    lastError: text('last_error'),
  },
  (t) => [
    // Invariant 26 — email sends are unique on the same triple as notifications.
    uniqueIndex('email_sends_account_type_dedupe_key').on(t.accountId, t.type, t.dedupeKey),
    // The send worker drains `queued` rows.
    index('email_sends_queued_idx')
      .on(t.queuedAt)
      .where(sql`${t.state} = 'queued'`),
    // The retention sweep keeps these for 12 months.
    index('email_sends_queued_at_idx').on(t.queuedAt),
  ],
)

/**
 * Addresses we have stopped emailing. Bounce and complaint webhooks from the
 * mail provider land here, and a suppressed address skips the queue — except
 * for account-security mail such as a deletion confirmation, which someone is
 * entitled to receive regardless.
 * Keyed by address, not by account: an address that bounced stays suppressed
 * regardless of which account tries to reach it.
 */
export const emailSuppressions = pgTable(
  'email_suppressions',
  {
    email: text('email').primaryKey(),
    reason: emailSuppressionReasonEnum('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('email_suppressions_created_at_idx').on(t.createdAt)],
)

/**
 * Preferences for the opt-in notifications only. The transactional and
 * pipeline-stopping ones — connection lost, review ready, repair needed — are
 * not toggleable, and that is enforced by there being no column for them to
 * read rather than by a check somewhere.
 */
export const notificationPrefs = pgTable('notification_prefs', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  emailArticlePublished: boolean('email_article_published').notNull().default(false),
  emailDigestFrequency: emailDigestFrequencyEnum('email_digest_frequency')
    .notNull()
    .default('off'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

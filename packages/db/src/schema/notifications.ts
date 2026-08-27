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
 * tech §1.2 — event notifications (the bell). Append-only records written at
 * the moment the domain event occurs, inside the same transaction as the state
 * change where one exists. Attention items are **not** here: they are live
 * queries over underlying state (tech §1.1), which is invariant 26's other half.
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
     * tech §1.2 — type-specific: article_id for publishes, topic_id for gate
     * holds, opportunity_id for recommendations, ISO week for weekly scans,
     * date for summaries. Not nullable: every type must name its dedupe key,
     * which is what makes the unique index below the exactly-once guarantee
     * under at-least-once workers.
     */
    dedupeKey: text('dedupe_key').notNull(),
    payloadJson: jsonb('payload_json').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // tech §1.2 — badge cleared by opening the bell vs item clicked.
    seenAt: timestamp('seen_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [
    // Invariant 26 — a retried publish job cannot ring the bell twice.
    uniqueIndex('notifications_account_type_dedupe_key').on(t.accountId, t.type, t.dedupeKey),
    // tech §1.6 — GET /api/notifications?since= returns unseen count + recent items.
    index('notifications_account_created_at_idx').on(t.accountId, t.createdAt),
    index('notifications_account_unseen_idx')
      .on(t.accountId)
      .where(sql`${t.seenAt} IS NULL`),
    // tech §1.7 — pruned at 90 days.
    index('notifications_created_at_idx').on(t.createdAt),
  ],
)

/**
 * tech §1.4 — the email pipeline. The unique index is the exactly-once-send
 * guarantee under at-least-once workers, and the same triple is sent to Resend
 * as its idempotency-key header for provider-side dedupe on top.
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
    // tech §1.4 — stamped on every send, same reproducibility posture as prompts.
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
    // tech §1.7 — kept 12 months.
    index('email_sends_queued_at_idx').on(t.queuedAt),
  ],
)

/**
 * tech §1.5 — Resend bounce/complaint webhooks land here; suppressed addresses
 * skip the queue except for account-security email (deletion confirmation).
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
 * tech §1.3 — preferences for the matrix's opt-in rows only. Transactional and
 * pipeline-stopping categories (connection lost, review ready, repair needed)
 * are not toggleable, enforced by there being no column for them to read.
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

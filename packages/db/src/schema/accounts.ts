import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  deliveryModeEnum,
  planEnum,
  shopifyPublishAsEnum,
  subscriptionStatusEnum,
} from './enums'

/** main §13 `accounts`. One account, one domain, no teams (main §18). */
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    plan: planEnum('plan').notNull().default('pro'),
    stripeCustomerId: text('stripe_customer_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // main §4.1 — email is the login identity, so it is the account identity.
    uniqueIndex('accounts_email_key').on(t.email),
    uniqueIndex('accounts_stripe_customer_id_key')
      .on(t.stripeCustomerId)
      .where(sql`${t.stripeCustomerId} IS NOT NULL`),
  ],
)

/**
 * main §13 `subscriptions`, §4.2. Written **only** by the Stripe webhook worker
 * (invariant 16); `synced_at` drives the nightly reconciliation of any row
 * stale > 24h.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    accountId: uuid('account_id')
      .primaryKey()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    stripeSubscriptionId: text('stripe_subscription_id').notNull(),
    priceId: text('price_id').notNull(),
    status: subscriptionStatusEnum('status').notNull(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('subscriptions_stripe_subscription_id_key').on(t.stripeSubscriptionId),
    // The nightly reconciliation job scans by staleness.
    index('subscriptions_synced_at_idx').on(t.syncedAt),
  ],
)

/**
 * main §13 `stripe_events`, §4.2, §14.3.8. Signature-verified, insert-or-ignore
 * by event id, 200 immediately, processed async.
 */
export const stripeEvents = pgTable(
  'stripe_events',
  {
    eventId: text('event_id').primaryKey(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    index('stripe_events_unprocessed_idx')
      .on(t.receivedAt)
      .where(sql`${t.processedAt} IS NULL`),
  ],
)

/** main §13 `account_settings` — the settings surface (UI spec §9). */
export const accountSettings = pgTable('account_settings', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  // main §9.4 — fixed publish hour, default 09:00 in the persona country's zone.
  publishHour: integer('publish_hour').notNull().default(9),
  // main §9.4 — IANA zone, defaulted from the persona country in T2.5.
  timezone: text('timezone').notNull().default('UTC'),
  draftReview: boolean('draft_review').notNull().default(false),
  // main §14.1 — auto-repair on by default.
  autoRepair: boolean('auto_repair').notNull().default(true),
  // main §9.5 — export is the default; auto-publish is a second consent.
  delivery: deliveryModeEnum('delivery').notNull().default('export'),
  shopifyPublishAs: shopifyPublishAsEnum('shopify_publish_as').notNull().default('live'),
  // main §14.6 — halts generation and publishing, keeps sync and reporting alive.
  vacationMode: boolean('vacation_mode').notNull().default(false),
  uiLanguage: text('ui_language'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

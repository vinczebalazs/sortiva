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

/** One account, one domain. There are no teams and no seats in V1. */
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
    // Email is the login identity, so it is the account identity.
    uniqueIndex('accounts_email_key').on(t.email),
    uniqueIndex('accounts_stripe_customer_id_key')
      .on(t.stripeCustomerId)
      .where(sql`${t.stripeCustomerId} IS NOT NULL`),
  ],
)

/**
 * Our own copy of the Stripe subscription, written **only** by the webhook
 * worker. Everything that asks "is this account entitled" reads this row, so
 * entitlement never depends on Stripe answering right now.
 *
 * Two timestamps, because the row answers two different questions and one
 * column cannot hold both answers safely:
 *
 * - `synced_at` — when we last successfully contacted Stripe about this row.
 *   The nightly reconciliation scans it and re-fetches anything over a day
 *   stale. Advancing it is always safe.
 * - `state_observed_at` — the ordering floor. See its own note below.
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
    /** The staleness clock the nightly reconciliation scans. */
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * The instant we read the state in this row from Stripe, and the monotonic
     * guard on the upsert (`WHERE state_observed_at <= EXCLUDED…`).
     *
     * DANGER: writing `now()` here on any path that did not just read this
     * subscription from Stripe sets the ordering floor to the present, so every
     * later webhook is discarded as stale and the account's billing status
     * freezes — silently, with no error and no log. Only the guarded upsert in
     * the billing store may write this column.
     */
    stateObservedAt: timestamp('state_observed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('subscriptions_stripe_subscription_id_key').on(t.stripeSubscriptionId),
    // The nightly reconciliation job scans by staleness.
    index('subscriptions_synced_at_idx').on(t.syncedAt),
  ],
)

/**
 * Every Stripe event we have received. Signature-verified, insert-or-ignore by
 * event id, answered 200 immediately, and processed afterwards from this table
 * — so a redelivery is free and a slow processor never times the webhook out.
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

/** Everything the Settings screens can change. */
export const accountSettings = pgTable('account_settings', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  // A fixed hour of the day to publish at, defaulting to 09:00 in the persona
  // country's zone.
  publishHour: integer('publish_hour').notNull().default(9),
  // IANA zone name, defaulted from the persona country during onboarding.
  timezone: text('timezone').notNull().default('UTC'),
  draftReview: boolean('draft_review').notNull().default(false),
  // Whether we fix our own published articles when the products they describe
  // change. On by default.
  autoRepair: boolean('auto_repair').notNull().default(true),
  // Export is the default; publishing on the merchant's behalf is a separate,
  // later consent.
  delivery: deliveryModeEnum('delivery').notNull().default('export'),
  shopifyPublishAs: shopifyPublishAsEnum('shopify_publish_as').notNull().default('live'),
  // Halts generation and publishing while leaving sync and reporting running,
  // so a merchant can go away without losing their data or their history.
  vacationMode: boolean('vacation_mode').notNull().default(false),
  uiLanguage: text('ui_language'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

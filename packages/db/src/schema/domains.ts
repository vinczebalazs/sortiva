import { sql } from 'drizzle-orm'
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { accounts } from './accounts'
import { domainPlatformEnum, domainStateEnum } from './enums'

/**
 * One domain per account, one account per domain, claimed at the registrable
 * domain so `blog.example.com` and `shop.example.com` cannot end up on two
 * accounts.
 *
 * Both halves are unique indexes here rather than checks in application code,
 * which is what lets the claim be an insert-with-conflict: two signups racing
 * for the same domain cannot both pass.
 */
export const domains = pgTable(
  'domains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    domainNormalized: text('domain_normalized').notNull(),
    platform: domainPlatformEnum('platform'),
    state: domainStateEnum('state').notNull().default('ingesting'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * On account deletion the claim is released after a 7-day
     * grace window, so a squatter cannot take the domain the same hour. Set
     * while the row still holds the unique index; the release sweep (T8.3)
     * deletes the row once the window passes.
     */
    releaseAfter: timestamp('release_after', { withTimezone: true }),
  },
  (t) => [
    // Invariant 1a — one domain per account.
    uniqueIndex('domains_account_id_key').on(t.accountId),
    // Invariant 1b — one account per domain, globally.
    uniqueIndex('domains_domain_normalized_key').on(t.domainNormalized),
    index('domains_state_idx').on(t.state),
  ],
)

/**
 * The logged-out preview's cache.
 *
 * Preview output is disposable: nothing here is ever read by ingestion, persona,
 * topics or evidence. It comes from a scrape of a stranger's homepage with no
 * catalog behind it, so it is not good enough to build on. Keyed by domain
 * rather than by account, because at preview time there is no account.
 */
export const previewCache = pgTable(
  'preview_cache',
  {
    domainNormalized: text('domain_normalized').primaryKey(),
    summary: jsonb('summary').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('preview_cache_expires_at_idx').on(t.expiresAt)],
)

/**
 * One store's Shopify connection. Reading the store is granted at install;
 * permission to publish into it is a separate, later grant, so a merchant never
 * discovers we can post to their blog by seeing a post appear. The token column
 * holds ciphertext, never a token: it is encrypted in our application layer, so
 * a database dump alone yields nothing usable.
 */
export const shopifyConns = pgTable(
  'shopify_conns',
  {
    accountId: uuid('account_id')
      .primaryKey()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    shopHandle: text('shop_handle').notNull(),
    accessToken: text('access_token').notNull(),
    grantedScopes: text('granted_scopes').array().notNull().default(sql`'{}'::text[]`),
    // Set only when auto-publish is enabled; null for export-only accounts.
    targetBlogId: text('target_blog_id'),
    targetBlogHandle: text('target_blog_handle'),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
    // When Shopify rejected our token. The account moves to
    // awaiting_shopify_auth and the merchant is asked to reconnect.
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('shopify_conns_shop_handle_key').on(t.shopHandle)],
)

import { sql } from 'drizzle-orm'
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { accounts } from './accounts'
import { domainPlatformEnum, domainStateEnum } from './enums'

/**
 * main §13 `domains`, §2 core invariants 1 and 2, §5.
 *
 * Invariant 1 of the constitution: one domain per account, one account per
 * domain, claimed at eTLD+1. Both halves are unique indexes here, "enforced at
 * the database level, not just in application code" (main §2) — which is what
 * makes the claim an insert-with-conflict rather than a check-then-insert.
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
     * main §14.6 — on account deletion the claim is released after a 7-day
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
 * main §13 `preview_cache`, §2 invariant 3, §3.2.
 *
 * Constitution invariant 2: preview output is disposable — nothing here is ever
 * read by ingestion, persona, topics, or evidence. It is keyed by domain rather
 * than by account precisely because previews are pre-auth: there is no account.
 * 7-day TTL per main §3.2.
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
 * main §13 `shopify_conns`, §6.2. Read scopes at install; `write_content` is a
 * separate later grant (invariant 21). The token is envelope-encrypted at the
 * application layer (tech §4) — this column holds ciphertext, never a token.
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
    // main §9.5 — set only when auto-publish is enabled; null for export-only.
    targetBlogId: text('target_blog_id'),
    targetBlogHandle: text('target_blog_handle'),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
    // main §14.4 — a 401 from Shopify moves the account to awaiting_shopify_auth.
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('shopify_conns_shop_handle_key').on(t.shopHandle)],
)

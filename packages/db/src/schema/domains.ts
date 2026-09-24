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
     * while the row still holds the unique index.
     *
     * The deadline is what releases the domain, not the sweep that eventually
     * removes the row: a claim on a domain whose date here has passed drops
     * the row itself and proceeds. That is what stops a sweep which never runs
     * from holding a domain for ever.
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
    /**
     * When the access token stops working. Shopify issues hour-long tokens to
     * apps like ours, so a token is renewed shortly before this rather than
     * after a merchant's sync has already failed.
     */
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    /**
     * What buys the next access token, encrypted like the token itself. Shopify
     * hands back a new one with every renewal and retires the previous one the
     * first time the new one is used, so the column always holds the newest.
     */
    refreshToken: text('refresh_token'),
    /** When the merchant would have to grant permission again rather than us renewing it. */
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    grantedScopes: text('granted_scopes').array().notNull().default(sql`'{}'::text[]`),
    /**
     * The host the storefront actually serves on, as the store itself reports
     * it — which is what a published article's address is built from and what
     * Search Console reports traffic under. Not the domain claimed at signup:
     * that one is stored stripped of `www.` and of any subdomain, so for a store
     * on `www.` or on a subdomain the two are different strings and articles
     * recorded under the claimed one match no search data at all.
     */
    storefrontHost: text('storefront_host'),
    /**
     * The store's own name, as Shopify reports it. Every article we post
     * carries an author, Shopify requires one, and it is the merchant's shop
     * name — a blog of theirs should not carry a byline naming a tool.
     */
    shopName: text('shop_name'),
    /**
     * Whether this account has ever granted permission to publish, even if the
     * connection has since been lost. It is what lets a reconnect keep a write
     * grant that would otherwise be thrown away as unasked-for, without ever
     * accepting one on a first install.
     */
    publishGrantedAt: timestamp('publish_granted_at', { withTimezone: true }),
    // Set only when auto-publish is enabled; null for export-only accounts.
    targetBlogId: text('target_blog_id'),
    targetBlogHandle: text('target_blog_handle'),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
    // When Shopify rejected our token. The account moves to
    // awaiting_shopify_auth and the merchant is asked to reconnect.
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
  },
  (t) => [
    /**
     * One *live* connection per store, rather than one row per store ever.
     *
     * A store whose token we lost — the merchant uninstalled us, or revoked the
     * grant — should not go on holding the handle against a fresh connection.
     * Under an unconditional unique index it did: a merchant who deleted their
     * account and signed up again could never reconnect the same store, because
     * the abandoned row still owned the handle and nothing in the product could
     * clear it. Narrowing the index to live rows makes losing a connection an
     * actual release rather than a permanent lock.
     *
     * Two rows may now carry the same handle, so any lookup by handle must say
     * which one it wants; `findAccountByShopHandle` asks for the live one.
     */
    uniqueIndex('shopify_conns_shop_handle_key')
      .on(t.shopHandle)
      .where(sql`${t.invalidatedAt} IS NULL`),
  ],
)

import { sql } from 'drizzle-orm'
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { accounts } from './accounts'
import { bytea } from './columns'
import { articles } from './content-engine'
import { intentClassEnum, storePageStatusEnum, storePageTypeEnum } from './enums'

/**
 * What the store already has: one row per URL, built from the Shopify Admin API
 * (collections, products, pages, blogs, articles) plus our own published
 * articles — there is no crawler in V1. This inventory is what the
 * existing-target check reads before any CREATE, which is the rule that
 * makes "improve the collection you already have" the default instead of
 * publishing a page that competes with it.
 *
 * `checksum` is the change detector: a changed page invalidates cached
 * intent-gap analyses and re-scores open opportunities on that URL at
 * the next scan.
 */
export const storePages = pgTable(
  'store_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    pageType: storePageTypeEnum('page_type').notNull(),
    /**
     * Whether the store still serves this URL.
     *
     * A 'gone' row is kept rather than deleted, because the walk can find the
     * page again and put it straight back to live — a restored page keeps the
     * checksum it always had, so nothing else would mark it live again. A
     * reader that deletes or archives on seeing 'gone' breaks that.
     *
     * Our own published articles are never marked 'gone': for a store we
     * deliver by export they may live somewhere the walk cannot see, so
     * absence is evidence of nothing.
     */
    status: storePageStatusEnum('status').notNull().default('live'),
    handle: text('handle'),
    /** Shopify's own id for the collection / product / page / article. */
    shopifyId: text('shopify_id'),
    title: text('title'),
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    /** The page's headings, which is what the coverage analysis compares against the top results. */
    headingsJson: jsonb('headings_json').notNull().default(sql`'[]'::jsonb`),
    /** Compressed like `raw_body_html`. Postgres is the store; there is no blob service. */
    bodyCompressed: bytea('body_compressed'),
    /** Parsed from the page body. Links that live in the theme's navigation are a known blind spot. */
    outboundInternalLinks: text('outbound_internal_links')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    familyIds: uuid('family_ids').array().notNull().default(sql`'{}'::uuid[]`),
    intentClass: intentClassEnum('intent_class'),
    checksum: text('checksum'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set on `article_ours` rows. Added by schema wave 3 (T4.0), which brought `articles` into being. */
    articleId: uuid('article_id').references(() => articles.id, { onDelete: 'set null' }),
  },
  (t) => [
    // T2.0 done-when: "store_pages unique url" — one row per URL per account.
    uniqueIndex('store_pages_account_url_key').on(t.accountId, t.url),
    index('store_pages_account_type_idx').on(t.accountId, t.pageType),
    index('store_pages_article_idx').on(t.articleId),
  ],
)

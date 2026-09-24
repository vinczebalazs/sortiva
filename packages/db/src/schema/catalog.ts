import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { accounts } from './accounts'
import { bytea } from './columns'
import {
  confidenceBandEnum,
  familyGroupingSourceEnum,
  topProductSourceEnum,
} from './enums'

/**
 * A store with 40 similar shoes cannot support 40 shoe articles, so everything
 * downstream (topic mapping, substance inventory, evidence packs,
 * cannibalization) operates on families, never individual products. The
 * differentiation axes are the prize: a family differing by terrain, drop and
 * width is a buying guide whose comparison skeleton is literally those axes.
 */
export const productFamilies = pgTable(
  'product_families',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** The attributes every member shares — the family's merged fact sheet. */
    mergedFactsJson: jsonb('merged_facts_json').notNull().default(sql`'{}'::jsonb`),
    /** The axes along which members differ — `{terrain, drop, width}`. */
    differentiationAxes: text('differentiation_axes').array().notNull().default(sql`'{}'::text[]`),
    memberCount: integer('member_count').notNull().default(0),
    /** Which clustering signal produced this family, recorded so a bad grouping can be traced to what caused it. */
    groupingSource: familyGroupingSourceEnum('grouping_source').notNull(),
    /** How much to trust the grouping. Families produced by the embeddings fallback rather than a clean attribute match are always `low`. */
    confidence: confidenceBandEnum('confidence').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('product_families_account_idx').on(t.accountId),
  ],
)

/**
 * One product as Shopify gave it to us.
 *
 * `raw_body_html` is quarantined: stored for display and debugging, never an
 * input to persona, topic selection, evidence packs or recommendations. A
 * merchant's marketing copy fed back into our own generation is how a system
 * ends up confidently repeating claims nobody checked, so only the distilled
 * fact sheet in `product_facts` flows downstream. The quarantine itself is a
 * boundary test owned by T2.3; this column is only its home.
 */
export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** Shopify's own product id. External ids are unique columns, never keys. */
    shopifyProductId: text('shopify_product_id').notNull(),
    title: text('title').notNull(),
    /** Quarantined — see the note above — and stored compressed, because it is bulky and rarely read. */
    rawBodyHtml: bytea('raw_body_html'),
    productType: text('product_type'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    variants: jsonb('variants').notNull().default(sql`'[]'::jsonb`),
    priceRange: jsonb('price_range'),
    /**
     * Shopify's own variant option definitions (e.g. `[{name: "Size", values:
     * [...]}, ...]`) and the product's metafields, as Shopify returns them.
     * Added by schema wave 3 (T4.0) — see DECISIONS 2026-09-03 T4.0. A store
     * that keeps its attributes here rather than in tags or descriptions
     * yields fewer differentiation axes without this; `T2.4` called it "the
     * single highest-value schema-wave addition" and it was deferred for lack
     * of a wave. Works only from each store's next full sync — existing rows
     * carry it only after they are re-synced.
     */
    options: jsonb('options').notNull().default(sql`'[]'::jsonb`),
    metafields: jsonb('metafields').notNull().default(sql`'[]'::jsonb`),
    /**
     * The product's pictures (`[{url, alt}, ...]`), in the store's own order.
     * An article about a product is published with one of them; with no stored
     * address there is nothing to send and the post goes out as a wall of text.
     * Filled from each store's next full sync.
     */
    images: jsonb('images').notNull().default(sql`'[]'::jsonb`),
    /** Shopify's `updated_at`. Distillation re-runs only when this moves, so an unchanged product costs nothing. */
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    /**
     * The other half of the distillation cache key, and what the drift sweep
     * compares to notice a product changed underneath a webhook we never got.
     * Neither is buildable without it.
     */
    checksum: text('checksum'),
    familyId: uuid('family_id').references(() => productFamilies.id, { onDelete: 'set null' }),
    /**
     * "Trailblazer Shoe — Red" and "— Blue" published as two products are one
     * logical product, and writing about them twice would be writing the same
     * article twice. This is a group id shared by the merged rows, not a
     * pointer to a row, so it carries no foreign key.
     */
    logicalProductId: uuid('logical_product_id'),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('products_account_shopify_id_key').on(t.accountId, t.shopifyProductId),
    index('products_account_family_idx').on(t.accountId, t.familyId),
    index('products_logical_product_idx').on(t.logicalProductId),
  ],
)

/**
 *
 * The extract-only fact sheet: "Premium quality leather" becomes
 * `material: leather` and the "premium" dies. A field the text doesn't support
 * stays null — "empty fields are signal, not failure" — so `fact_count` and
 * `fluff_discarded` are what the per-store richness score is computed from.
 */
export const productFacts = pgTable('product_facts', {
  productId: uuid('product_id')
    .primaryKey()
    .references(() => products.id, { onDelete: 'cascade' }),
  factsJson: jsonb('facts_json').notNull(),
  factCount: integer('fact_count').notNull().default(0),
  fluffDiscarded: integer('fluff_discarded').notNull().default(0),
  /** Invariant 25 — every LLM artefact is stamped with its prompt version and model. */
  promptVersion: text('prompt_version').notNull(),
  modelId: text('model_id').notNull(),
  distilledAt: timestamp('distilled_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Who this store is and who it sells to, in our own words.
 *
 * Produced by one model call over fact sheets, families, top sellers and the
 * homepage — never over raw product descriptions. The merchant confirms or
 * edits it during onboarding, which is what `confirmed_at` records.
 */
export const personas = pgTable('personas', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  /** Two to four sentences describing the business, written in the store's own language. */
  description: text('description').notNull(),
  /** The broad categories the store sells in. */
  productCategories: text('product_categories').array().notNull().default(sql`'{}'::text[]`),
  /** The store's main language. Also what we pass to the SEO data vendor, so a wrong value silently buys the wrong country's numbers. */
  language: text('language').notNull(),
  country: text('country').notNull(),
  audience: text('audience'),
  /** How the brand sounds, carried into everything we write for them. */
  tone: text('tone'),
  /** How much we actually know about this store's catalog, rolled up from the per-product fact counts. */
  richnessScore: numeric('richness_score', { precision: 6, scale: 2 }),
  promptVersion: text('prompt_version').notNull(),
  modelId: text('model_id').notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
})

/**
 * What the store actually sells most of.
 *
 * Order ingestion strips every customer field at read time, and that rule is
 * visible here as an absence: there is no column an email, name or address
 * could be written to, only the line-item aggregate. It is what lets us answer
 * a GDPR request with "no data held".
 */
export const topProducts = pgTable(
  'top_products',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    url: text('url'),
    revenue90d: numeric('revenue_90d', { precision: 14, scale: 2 }),
    qty90d: integer('qty_90d'),
    source: topProductSourceEnum('source').notNull(),
    rank: integer('rank').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('top_products_account_product_key').on(t.accountId, t.productId),
    // Not unique: the 90-day recompute rewrites ranks in place, and a unique
    // index would make an ordinary reordering a transient conflict.
    index('top_products_account_rank_idx').on(t.accountId, t.rank),
  ],
)

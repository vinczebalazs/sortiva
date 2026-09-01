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
 * main §13 `product_families`, §6.4.
 *
 * "A store with 40 similar shoes cannot support 40 shoe articles" — everything
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
    /** The attributes shared across members (§6.4 "merged fact sheet"). */
    mergedFactsJson: jsonb('merged_facts_json').notNull().default(sql`'{}'::jsonb`),
    /** The axes along which members differ — `{terrain, drop, width}`. */
    differentiationAxes: text('differentiation_axes').array().notNull().default(sql`'{}'::text[]`),
    memberCount: integer('member_count').notNull().default(0),
    /** §6.4 "Provenance logged" — which clustering signal produced this family. */
    groupingSource: familyGroupingSourceEnum('grouping_source').notNull(),
    /** §6.4 — the embeddings fallback is flagged `low`. */
    confidence: confidenceBandEnum('confidence').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('product_families_account_idx').on(t.accountId),
  ],
)

/**
 * main §13 `products`, §6.2, §6.3, §6.4.
 *
 * Constitution invariant 3: `raw_body_html` is quarantined — stored for display
 * and debugging, never an input to persona, topic selection, evidence packs or
 * recommendations. Only the distilled fact sheet in `product_facts` flows
 * downstream. The quarantine itself is a boundary test owned by T2.3; this
 * column is only its home.
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
    /** Invariant 3 — quarantined, and compressed per tech §2.1. */
    rawBodyHtml: bytea('raw_body_html'),
    productType: text('product_type'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    variants: jsonb('variants').notNull().default(sql`'[]'::jsonb`),
    priceRange: jsonb('price_range'),
    /** Shopify's `updated_at`. §6.3 re-runs distillation only when this moves. */
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    /**
     * The other half of the distillation cache key (build plan T2.3: "caching
     * on `updated_at` + checksum key") and what §14.3.8's reconciliation sweep
     * diffs on. §13's sketch lists neither; without it neither is buildable.
     */
    checksum: text('checksum'),
    familyId: uuid('family_id').references(() => productFamilies.id, { onDelete: 'set null' }),
    /**
     * §6.4 split-variant merge: "Trailblazer Shoe — Red" and "— Blue" published
     * as separate products are one logical product. This is a group id shared
     * by the merged rows, not a pointer to a row, so it carries no foreign key.
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
 * main §13 `product_facts`, §6.3.
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
 * main §13 `personas`, §6.5.
 *
 * One Sonnet call over fact sheets, families, top sellers and the homepage —
 * never raw product descriptions (§6.3). The merchant confirms or edits it at
 * §6.8, which is what `confirmed_at` records.
 */
export const personas = pgTable('personas', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  /** §6.5 `business_description` — 2–4 sentences, in the store's language. */
  description: text('description').notNull(),
  /** §6.5's output carries this; §13's sketch omits it. */
  productCategories: text('product_categories').array().notNull().default(sql`'{}'::text[]`),
  /** §6.5 `main_language` — the DataForSEO language parameter (§12.1). */
  language: text('language').notNull(),
  country: text('country').notNull(),
  audience: text('audience'),
  /** §6.5 `brand_tone`. */
  tone: text('tone'),
  /** §6.3 — per-product fact counts rolled up per store. */
  richnessScore: numeric('richness_score', { precision: 6, scale: 2 }),
  promptVersion: text('prompt_version').notNull(),
  modelId: text('model_id').notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
})

/**
 * main §13 `top_products`, §6.2.
 *
 * Constitution invariant 4: order ingestion strips every customer field at read
 * time. That rule is visible here as an absence — there is no column an email,
 * name or address could be written to, only the line-item aggregate.
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

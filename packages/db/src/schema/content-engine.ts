import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { accounts } from './accounts'
import { productFamilies, products } from './catalog'
import {
  articleLabelEnum,
  articleStateEnum,
  claimKindEnum,
  confidenceBandEnum,
  deliveryModeEnum,
  intentClassEnum,
  patternDimensionEnum,
  productRefFieldEnum,
  productRefTypeEnum,
  publishIntentStateEnum,
  topicKindEnum,
  topicSourceEnum,
  topicStateEnum,
} from './enums'
import { opportunities } from './opportunities'
import { queryClusters } from './search'

/**
 * Schema wave 3 (card T4.0) — the calendar and the content engine's own
 * tables: `topics`, `articles`, `gate_decisions`, `article_product_refs`,
 * `article_claims`, `article_labels`, `pattern_stats`, `refresh_log`,
 * `not_interested`, `publish_intents`. Main §13 (data model summary), §14.3.7
 * (two-phase publish), `docs/content-pointers.md` §1 and §9.
 *
 * Nothing in this file decides gate logic, calendar scheduling, or writer
 * behaviour — those are `T4.1`–`T4.6`'s cards. This is storage only.
 */

/**
 * The unit of content: a search opportunity + intent + product-family link
 * that cleared the existing-target check and was accepted onto the calendar.
 * Main §8.1: "every topic carries its `opportunity_id`" — stated without a
 * hedge for manual topics too, so the column is `NOT NULL` here.
 */
export const topics = pgTable(
  'topics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    // See the matching note in `opportunities.ts` on why the return type is explicit.
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references((): AnyPgColumn => opportunities.id),
    title: text('title').notNull(),
    targetKeyword: text('target_keyword'),
    /** Nullable: a manually-added topic may name no cluster at all. */
    keywordCluster: uuid('keyword_cluster').references(() => queryClusters.clusterId),
    intentClass: intentClassEnum('intent_class').notNull(),
    familyIds: uuid('family_ids').array().notNull().default(sql`'{}'::uuid[]`),
    kind: topicKindEnum('kind').notNull().default('new'),
    source: topicSourceEnum('source').notNull(),
    score: numeric('score', { precision: 10, scale: 4 }),
    /** Rendered from `reason_template_key` + params over the scoring record — never free LLM prose. Main §9.6.8. */
    whyLine: text('why_line'),
    scheduledDate: date('scheduled_date').notNull(),
    pinned: boolean('pinned').notNull().default(false),
    state: topicStateEnum('state').notNull().default('planned'),
    vetoReason: text('veto_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('topics_account_scheduled_idx').on(t.accountId, t.scheduledDate),
    index('topics_account_state_idx').on(t.accountId, t.state),
    index('topics_opportunity_idx').on(t.opportunityId),
  ],
)

/** One generated (or hand-approved) piece of content. Main §13 `articles`. */
export const articles = pgTable(
  'articles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    topicId: uuid('topic_id')
      .notNull()
      .references(() => topics.id),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    targetKeyword: text('target_keyword'),
    /**
     * The draft in the shape the writer produced it — intro, sections, FAQ —
     * rather than rendered prose. Every reader downstream wants the pieces: the
     * judge scores a section at a time, and the review screen shows them as
     * blocks. Flattening to markdown here would make each of them parse it back,
     * and prose is exactly where the structure gets lost.
     *
     * Null until the writer has run. The row is created first, because a claim
     * has to hang off an article that already exists.
     */
    bodyJson: jsonb('body_json'),
    /**
     * Beside `title` and `slug` rather than inside the body, because it is not
     * part of what a reader sees on the page: publishing and export both read it
     * as a field of their own.
     */
    metaDescription: text('meta_description'),
    state: articleStateEnum('state').notNull().default('draft'),
    /**
     * Main §8.6: an override-published article is excluded from calibration
     * data, pattern learning and headline performance claims, and shown
     * segmented. Invariant 12.
     */
    publishedViaOverride: boolean('published_via_override').notNull().default(false),
    delivery: deliveryModeEnum('delivery').notNull().default('export'),
    publishedUrl: text('published_url'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('articles_account_state_idx').on(t.accountId, t.state),
    uniqueIndex('articles_account_slug_key').on(t.accountId, t.slug),
    index('articles_topic_idx').on(t.topicId),
    // A draft is an object with named parts. A bare array or string here would
    // mean somebody stored rendered prose after all, which every reader would
    // then have to guess at.
    check(
      'articles_body_json_object_ck',
      sql`${t.bodyJson} IS NULL OR jsonb_typeof(${t.bodyJson}) = 'object'`,
    ),
  ],
)

/**
 * The full audit trail for every gate check on every topic, across all three
 * gates. Main §13 `gate_decisions`; main §8.5 ("log every gate decision with
 * scores and justifications to audit drift").
 *
 * `outcome` is free text, not a closed enum. Gate 1 alone has at least five
 * shapes (pass / zero-volume auto-reject / not-winnable / off-catalog /
 * converted-to-optimize-or-refresh), the manual-add path adds
 * proceed/proceed-with-warning of its own (main §8.7), and Gate 3 adds
 * `overridden` (main §8.6). None of that vocabulary is fixed yet — it belongs
 * to `T4.1`–`T4.4`, which have not been built — and a closed enum guessed now
 * could not be corrected later without another migration, which only a
 * schema-wave card may add. See DECISIONS 2026-09-03 T4.0.
 */
export const gateDecisions = pgTable(
  'gate_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    topicId: uuid('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    gate: smallint('gate').notNull(),
    outcome: text('outcome').notNull(),
    scoresJson: jsonb('scores_json'),
    /** Only a rejection is required to carry this — main §8.6. */
    reasonUserFacing: text('reason_user_facing'),
    /** Null for Gate 1, which is pure data checks and makes no model call. */
    promptVersion: text('prompt_version'),
    modelId: text('model_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('gate_decisions_gate_range_ck', sql`${t.gate} IN (1, 2, 3)`),
    index('gate_decisions_topic_idx').on(t.topicId, t.gate),
    index('gate_decisions_account_decided_idx').on(t.accountId, t.decidedAt),
  ],
)

/**
 * Where a volatile value (price, stock, sale status, product URL, title) is
 * placed in an article body. The body carries a placeholder naming this row's
 * `placeholder_key`, never the value itself — founder decision, 2026-09-01
 * (`DECISIONS.md`, card T4.0): a price is a reference resolved from the live
 * store at publish and every republish, never text written once at generation
 * time. `resolved_values_json` is the last resolution: what the reader was
 * actually shown, kept for display between resolutions and for the drift
 * sweep (main §14.1, as amended) to compare against.
 *
 * This supersedes main §13's literal `price_at_write` column — there is no
 * single "the" volatile value on a reference, and nothing is captured "at
 * write" any more; see the same founder decision.
 */
export const articleProductRefs = pgTable(
  'article_product_refs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    /**
     * Nullable, `ON DELETE SET NULL`: whether a deleted Shopify product's
     * local row is hard-deleted or soft-marked is unsettled (DECISIONS
     * 2026-09-02 T3.2). `SET NULL` keeps this row — which is what has to
     * exist to raise the repair content-pointers.md §9 asks for ("if the
     * product is gone, the publish fails and a repair is raised") — under
     * either eventual answer; a plain `RESTRICT` would block the product
     * deletion outright, and `CASCADE` would destroy the evidence that a
     * reference has gone dangling.
     */
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
    familyId: uuid('family_id').references(() => productFamilies.id, { onDelete: 'set null' }),
    refType: productRefTypeEnum('ref_type').notNull(),
    /** The marker the article body carries in place of a value; how the resolver finds this row. */
    placeholderKey: text('placeholder_key').notNull(),
    fieldsRendered: productRefFieldEnum('fields_rendered').array().notNull(),
    /** e.g. `{"price": "$49.99", "url": "https://…"}` — one entry per field named in `fields_rendered`. */
    resolvedValuesJson: jsonb('resolved_values_json').notNull().default(sql`'{}'::jsonb`),
    /** Null until the first resolution — main §9's publish-time resolve, and every republish after. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Done-when: "a reference row names at least one field to render."
    // `cardinality()`, not `array_length()`: Postgres's `array_length` returns
    // NULL (not 0) for an empty array, and a CHECK that evaluates to NULL is
    // treated as satisfied — so `array_length(...) >= 1` silently let an empty
    // array through. `cardinality()` returns 0 for an empty array, which
    // actually fails the comparison.
    check(
      'article_product_refs_fields_nonempty_ck',
      sql`cardinality(${t.fieldsRendered}) >= 1`,
    ),
    uniqueIndex('article_product_refs_article_placeholder_key').on(t.articleId, t.placeholderKey),
    index('article_product_refs_product_idx').on(t.productId),
  ],
)

/**
 * One assertion an article makes, planned before the draft is written and
 * bound to the evidence that supports it — content-pointers.md §1, the
 * largest idea that document proposes. Provenance is internal: queryable, but
 * it never renders into the published article.
 */
export const articleClaims = pgTable(
  'article_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    kind: claimKindEnum('kind').notNull(),
    confidence: confidenceBandEnum('confidence').notNull(),
    /**
     * One entry per piece of evidence: which product, which page, which
     * quoted passage, or — for a derived fact or a recommendation — which
     * other claim in this same article it rests on
     * (content-pointers.md §1: "must name the claims it rests on"). An array
     * because a derived fact or recommendation typically cites more than one.
     */
    evidenceJson: jsonb('evidence_json').notNull(),
    /** Which article sections used this claim. */
    sections: text('sections').array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Done-when: "a claim row cannot exist without at least one evidence entry."
    check(
      'article_claims_evidence_nonempty_ck',
      sql`jsonb_typeof(${t.evidenceJson}) = 'array' AND jsonb_array_length(${t.evidenceJson}) >= 1`,
    ),
    index('article_claims_article_idx').on(t.articleId),
  ],
)

/**
 * One weekly-recomputed performance window for one article, against the
 * store's own median — main §13 `article_labels`, §9.6.2. Unique per window so
 * a re-run of the weekly recompute updates the row rather than duplicating it.
 */
export const articleLabels = pgTable(
  'article_labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    label: articleLabelEnum('label').notNull(),
    windowStart: date('window_start').notNull(),
    windowEnd: date('window_end').notNull(),
    clicks: integer('clicks'),
    impressions: integer('impressions'),
    meanPosition: numeric('mean_position', { precision: 6, scale: 2 }),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('article_labels_article_window_key').on(t.articleId, t.windowStart, t.windowEnd),
  ],
)

/**
 * The current pattern multiplier per dimension value — one row per
 * `(account, dimension, dimension_value)`, recomputed in place rather than
 * logged as history. Main §13 `pattern_stats`, §9.6.3 ("active iff `rated_n`
 * >= 3"). Unused until `T7.1` builds the learning loop that writes it — M7 is
 * deferred (`DECISIONS.md` 2026-09-02) — but `T4.6`'s replenishment scoring
 * reads it with a stub multiplier and needs the table to exist now.
 */
export const patternStats = pgTable(
  'pattern_stats',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    dimension: patternDimensionEnum('dimension').notNull(),
    dimensionValue: text('dimension_value').notNull(),
    ratedN: integer('rated_n').notNull().default(0),
    winnerN: integer('winner_n').notNull().default(0),
    underperformerN: integer('underperformer_n').notNull().default(0),
    multiplier: numeric('multiplier', { precision: 6, scale: 4 }).notNull().default('1'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'pattern_stats_pk',
      columns: [t.accountId, t.dimension, t.dimensionValue],
    }),
  ],
)

/** The 60-day refresh-cooldown source, main §13 / §9.6.5. */
export const refreshLog = pgTable(
  'refresh_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('refresh_log_article_refreshed_idx').on(t.articleId, t.refreshedAt)],
)

/**
 * The calendar veto list, main §13 / §8.7: a vetoed topic's fingerprint, so
 * replenishment never re-proposes it.
 */
export const notInterested = pgTable(
  'not_interested',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    topicFingerprint: text('topic_fingerprint').notNull(),
    vetoedAt: timestamp('vetoed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'not_interested_pk', columns: [t.accountId, t.topicFingerprint] }),
  ],
)

/**
 * Two-phase publish, main §14.3.7 in full. `article_external_id` is the
 * global dedupe: a second worker attempting the same publish (or the same
 * revision, whose intent embeds `revision_n` into this same column per
 * §14.3.7 step 5) hits the unique-violation and stops.
 */
export const publishIntents = pgTable(
  'publish_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    articleExternalId: text('article_external_id').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    revisionN: integer('revision_n').notNull().default(0),
    state: publishIntentStateEnum('state').notNull().default('pending'),
    shopifyArticleId: text('shopify_article_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  },
  (t) => [
    // Done-when: "publish_intents unique external id."
    uniqueIndex('publish_intents_article_external_id_key').on(t.articleExternalId),
    // The 5-minute recovery sweeper's own query: pending intents older than 10 minutes.
    index('publish_intents_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.state} = 'pending'`),
  ],
)

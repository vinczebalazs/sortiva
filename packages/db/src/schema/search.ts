import { sql } from 'drizzle-orm'
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { accounts } from './accounts'
import { intentClassEnum } from './enums'

/**
 * main §13 `gsc_conns`, §12.2.
 *
 * Search Console is an Opportunity Engine *input*, consulted before topic
 * discovery so the system never creates a new URL for an intent an existing
 * page already serves. `connected_at` is also the anchor for the dashboard's
 * "your search performance since connecting" chart.
 */
export const gscConns = pgTable('gsc_conns', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  /** The GSC property the merchant picked; its host is validated against the claimed eTLD+1. */
  property: text('property').notNull(),
  /** Envelope-encrypted at the application layer (tech §4) — ciphertext, never a token. */
  tokens: text('tokens').notNull(),
  connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
  /**
   * main §14.4 — a refresh failure stops reporting while the content pipeline
   * continues, and raises a reconnect prompt. Recording *when* is what makes
   * that reminder idempotent, exactly as `shopify_conns.invalidated_at` does.
   */
  invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
})

/**
 * main §13 `gsc_daily`, §12.2. Page-level totals; the page × query rows live in
 * `gsc_query_daily`. tech §2.1 keeps 16 months, then rolls up to monthly.
 */
export const gscDaily = pgTable(
  'gsc_daily',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    page: text('page').notNull(),
    clicks: integer('clicks').notNull().default(0),
    impressions: integer('impressions').notNull().default(0),
    position: numeric('position', { precision: 6, scale: 2 }),
  },
  (t) => [
    primaryKey({ name: 'gsc_daily_pk', columns: [t.accountId, t.date, t.page] }),
    index('gsc_daily_account_date_idx').on(t.accountId, t.date),
  ],
)

/**
 * main §13 `gsc_query_daily`, §12.2 — "the input to §7.3 detection". The weekly
 * scan reads this table; detection never makes a live Search Console call.
 *
 * The row is one full bucket of the four dimensions §12.2 requests
 * (`page, query, device, country`), so all four are part of its identity and
 * none may be null — a nullable dimension in a key silently permits duplicates,
 * since Postgres treats nulls as distinct.
 */
export const gscQueryDaily = pgTable(
  'gsc_query_daily',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    page: text('page').notNull(),
    query: text('query').notNull(),
    device: text('device').notNull(),
    country: text('country').notNull(),
    clicks: integer('clicks').notNull().default(0),
    impressions: integer('impressions').notNull().default(0),
    position: numeric('position', { precision: 6, scale: 2 }),
  },
  (t) => [
    primaryKey({
      name: 'gsc_query_daily_pk',
      columns: [t.accountId, t.date, t.page, t.query, t.device, t.country],
    }),
    index('gsc_query_daily_account_date_idx').on(t.accountId, t.date),
    index('gsc_query_daily_account_query_idx').on(t.accountId, t.query),
  ],
)

/**
 * main §13 `query_clusters`, §9.6.3.
 *
 * The lineage object: a head query plus its related-keyword expansion. §7.7
 * resolves a candidate to one of these before looking for an existing target,
 * and `topics.keyword_cluster` (schema wave 3) points back at it.
 */
export const queryClusters = pgTable(
  'query_clusters',
  {
    clusterId: uuid('cluster_id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    headQuery: text('head_query').notNull(),
    memberQueries: text('member_queries').array().notNull().default(sql`'{}'::text[]`),
    intentClass: intentClassEnum('intent_class'),
    familyIds: uuid('family_ids').array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('query_clusters_account_head_idx').on(t.accountId, t.headQuery)],
)

/**
 * main §13 `ctr_curve`, §7.3 (Low CTR at Strong Rank).
 *
 * The store's *own* fitted position→CTR curve. §7.3 is emphatic that the
 * comparison is never a fixed industry benchmark, because device, brand mix and
 * SERP features distort it. Refit weekly, so the table keeps the history and
 * the newest `fitted_at` is the live one.
 */
export const ctrCurve = pgTable(
  'ctr_curve',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    fittedAt: timestamp('fitted_at', { withTimezone: true }).notNull().defaultNow(),
    curveJson: jsonb('curve_json').notNull(),
    sampleN: integer('sample_n').notNull().default(0),
    /** §7.3 — branded queries are excluded where the brand token is detectable. */
    brandedExcluded: boolean('branded_excluded').notNull().default(false),
  },
  (t) => [primaryKey({ name: 'ctr_curve_pk', columns: [t.accountId, t.fittedAt] })],
)

/**
 * main §13 `serp_snapshots`, §12.1, §12.6.
 *
 * Where query-level SERP competitors live: the ranking URLs, their domains, and
 * for the top five a reference to fetched content used by the Gate 3 judge and
 * intent-gap analysis. Invariant 5: these are **never** copied into
 * `competitors` and are never user-editable.
 *
 * Keyed by canonical request parameters rather than by account, like
 * `request_cache` (main §14.3.6) — two accounts asking the same question in the
 * same locale must not pay DataForSEO twice. So this table has no `account_id`
 * and is reached under `SystemScope`; see `scope.ts`.
 */
export const serpSnapshots = pgTable(
  'serp_snapshots',
  {
    cacheKey: text('cache_key').primaryKey(),
    query: text('query').notNull(),
    locale: text('locale').notNull(),
    resultsJson: jsonb('results_json').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    /** §12.1 — SERP snapshots cache for 7 days. Stored as an instant, like every other cache in this schema. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('serp_snapshots_expires_at_idx').on(t.expiresAt)],
)

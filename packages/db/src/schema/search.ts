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
 * One store's Search Console connection.
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
  /** Ciphertext, never a token: encrypted in our application layer, so a database dump alone yields nothing usable. */
  tokens: text('tokens').notNull(),
  connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
  /**
   * A dead token stops reporting while the content pipeline carries on, and
   * raises a prompt to reconnect. Recording *when* is what makes
   * that reminder idempotent, exactly as `shopify_conns.invalidated_at` does.
   */
  invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
})

/**
 * Page-level Search Console totals per day; the page × query rows live in
 * `gsc_query_daily`. Kept for 16 months, then rolled up to monthly.
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
 * The table signal detection actually reads. The weekly scan works from here;
 * detection never makes a live Search Console call, so a slow or failing API
 * cannot stall the engine.
 *
 * A row is one full bucket of all four dimensions (`page, query, device,
 * country`), so all four are part of its identity and
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
 * The monthly roll-up `gsc_daily` retires into once a row passes sixteen
 * months, so Search Console history compacts instead of being deleted
 * outright. Added by schema wave 3 (T4.0) — see DECISIONS 2026-09-03 T4.0 and
 * DECISIONS 2026-09-02 T8.3, which pruned to sixteen months with nowhere to
 * roll into and named this table as what the next wave owed it. Google itself
 * only serves sixteen months, so this is the only place a store's older
 * search history survives at all.
 */
export const gscMonthly = pgTable(
  'gsc_monthly',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** The first day of the month this row summarises, e.g. `2026-09-01`. */
    month: date('month').notNull(),
    page: text('page').notNull(),
    clicks: integer('clicks').notNull().default(0),
    impressions: integer('impressions').notNull().default(0),
    position: numeric('position', { precision: 6, scale: 2 }),
  },
  (t) => [
    primaryKey({ name: 'gsc_monthly_pk', columns: [t.accountId, t.month, t.page] }),
    index('gsc_monthly_account_month_idx').on(t.accountId, t.month),
  ],
)

/**
 * `gsc_query_daily`'s roll-up, on the same terms as `gsc_monthly` above.
 *
 * Rolled up by `(page, query)` only — `device` and `country` are summed away.
 * Keeping all four dimensions at monthly grain forever would defeat the reason
 * this table exists (tech §2.1's "Postgres stays small"), and nothing
 * downstream reasons about device/country beyond the daily window: detection
 * (main §7.3) reads `gsc_query_daily`, and the CTR curve (`ctr_curve`) is
 * refit weekly from there too. See DECISIONS 2026-09-03 T4.0.
 */
export const gscQueryMonthly = pgTable(
  'gsc_query_monthly',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    month: date('month').notNull(),
    page: text('page').notNull(),
    query: text('query').notNull(),
    clicks: integer('clicks').notNull().default(0),
    impressions: integer('impressions').notNull().default(0),
    position: numeric('position', { precision: 6, scale: 2 }),
  },
  (t) => [
    primaryKey({ name: 'gsc_query_monthly_pk', columns: [t.accountId, t.month, t.page, t.query] }),
    index('gsc_query_monthly_account_month_idx').on(t.accountId, t.month),
  ],
)

/**
 * A head query plus the related keywords it expands to — the unit almost
 * everything downstream reasons about, rather than individual keywords. A
 * candidate is resolved to one of these before we look for an existing target,
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
 * The store's *own* fitted position-to-CTR curve, which is what the low-CTR
 * signal compares against. Never a fixed industry benchmark: device mix, brand
 * mix and SERP features distort those enough to make the comparison
 * meaningless. Refit weekly, so the table keeps the history and
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
    /** Whether branded queries were excluded from the fit. They rank and convert unlike anything else, so leaving them in flatters the curve. */
    brandedExcluded: boolean('branded_excluded').notNull().default(false),
  },
  (t) => [primaryKey({ name: 'ctr_curve_pk', columns: [t.accountId, t.fittedAt] })],
)

/**
 * Who actually ranks for a query: the URLs, their domains, and for the top five
 * a reference to fetched content used by draft grading and intent-gap analysis.
 *
 * These are **never** copied into `competitors` and are never user-editable. A
 * domain that outranks the store is not necessarily a business it competes
 * with, and quietly promoting one into the merchant's competitor list would put
 * words in their mouth. They may be *suggested*; they are never added.
 *
 * Keyed by canonical request parameters rather than by account, like
 * `request_cache` — two accounts asking the same question in the same locale
 * must not make us pay the vendor twice. So this table has no `account_id`
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
    /** When this snapshot stops being reusable. Stored as an instant, like every other cache in this schema. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('serp_snapshots_expires_at_idx').on(t.expiresAt)],
)

import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { spendOutcomeEnum, spendVendorEnum } from './enums'

/**
 * The meter the daily spend caps are computed from. Added on 2026-08-31 with the
 * founder's agreement.
 *
 * This is the boundary the table exists to hold: analytics displays cost, our
 * own code enforces the caps. A kill switch has to work when the analytics
 * vendor is down or its events are delayed, so it cannot be the thing the
 * switch reads. Before this table the cap *numbers* existed in
 * `packages/rules/signals.config.yaml` and the meter did not, so the kill
 * switches had nothing to read.
 *
 * Two properties are structural, not conventions:
 *
 * 1. **Append-only.** A cost that has been incurred is never revised. The
 *    database refuses `UPDATE` outright — see
 *    `migrations/0003_wave2_guards.sql`. `DELETE` stays open for the retention
 *    sweep.
 * 2. **A cache hit is recorded at zero, never omitted.** A replay served from
 *    `request_cache` is written with `cache_hit: true` and zero cost. Omitting
 *    the row instead would make re-used work vanish from the spend picture
 *    rather than show up as free, so `cache_hit` with a non-zero cost is
 *    rejected outright.
 *
 * Nothing writes here yet: card `R2` wires the three instrumented vendor
 * wrappers to it, on success *and* on every failure path (remediation D2 —
 * both paid vendors bill for work performed, not for bytes we received).
 */
export const spendEvents = pgTable(
  'spend_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Who the money was spent on behalf of, as a column pair. Ten strangers
     * previewing `nike.com` is not Nike-the-account costing us money, so a
     * logged-out preview records the domain it was for rather than borrowing an
     * account it has nothing to do with.
     *
     * Exactly one of these is set, mirroring `EventAttribution` in
     * `packages/core/src/contracts/analytics.ts`, which is a union of the same
     * two cases. The check constraint below is what makes every dollar
     * attributable to either an account or a preview target and never both.
     *
     * Deliberately **not** a foreign key. A cascade would let account deletion
     * erase money we actually spent, which is the opposite of append-only;
     * `SET NULL` would leave a row attributable to nobody and break the check
     * below. What account deletion has to remove is personal data and
     * order-derived aggregates — a line on a vendor invoice is neither.
     */
    accountId: uuid('account_id'),
    previewTarget: text('preview_target'),
    /**
     * Which article this call was spent on, when it was spent on one at all —
     * most spend (persona, keywords, enrichment) is not attributable to a
     * single article. Added by schema wave 3 (T4.0) so `article_cost_finalized`
     * (`packages/core/src/ops/article-cost.ts`) can sum this ledger by article
     * instead of the caller summing the calls it made itself (see DECISIONS
     * 2026-08-31 R3, which built the event with nothing to call it from).
     *
     * No foreign key, on the same reasoning as `account_id` above: an article
     * being discarded must never erase the record of what it cost to attempt.
     */
    articleId: uuid('article_id'),
    vendor: spendVendorEnum('vendor').notNull(),
    /**
     * What the money bought: one of our LLM call types (`distill`, `persona`,
     * `seeds`, `judge`, `preview`, `intent_gap`, `optimize_reco`) or a vendor
     * endpoint name. Free text rather than an enum, because the endpoint side is
     * the vendor's vocabulary and a new endpoint must not need a migration.
     */
    callType: text('call_type').notNull(),
    usdCost: numeric('usd_cost', { precision: 14, scale: 8 }).notNull(),
    cacheHit: boolean('cache_hit').notNull().default(false),
    outcome: spendOutcomeEnum('outcome').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'spend_events_attribution_ck',
      sql`(${t.accountId} IS NOT NULL AND ${t.previewTarget} IS NULL) OR (${t.accountId} IS NULL AND ${t.previewTarget} IS NOT NULL)`,
    ),
    check('spend_events_cost_nonnegative_ck', sql`${t.usdCost} >= 0`),
    // A replay is free work, recorded as such. Charging for one would inflate
    // the very number the caps are computed from.
    check('spend_events_cache_hit_is_free_ck', sql`${t.cacheHit} = false OR ${t.usdCost} = 0`),
    // Supports summing one article's all-in cost at `article_cost_finalized` time.
    index('spend_events_article_idx')
      .on(t.articleId, t.occurredAt)
      .where(sql`${t.articleId} IS NOT NULL`),
    // Supports the per-account daily trip: today's spend against this account's
    // own trailing median, and against the hard ceiling.
    index('spend_events_account_occurred_idx').on(t.accountId, t.occurredAt),
    // Supports the global per-vendor daily cap.
    index('spend_events_vendor_occurred_idx').on(t.vendor, t.occurredAt),
    // Supports the preview's own daily cap. Preview rows have no account, so
    // they need their own partial index.
    index('spend_events_preview_occurred_idx')
      .on(t.occurredAt)
      .where(sql`${t.accountId} IS NULL`),
  ],
)

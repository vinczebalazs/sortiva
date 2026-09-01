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
 * The meter behind main §14.5's spend caps. Added to this wave by
 * `docs/audits/remediation.md` D1 (founder-accepted 2026-08-31); the reasoning
 * is `docs/audits/T0.5.md` finding 1.
 *
 * main §14.7 draws the boundary this table exists to hold: "The §14.5 budget
 * auto-trips read spend from our own DB counters — PostHog displays cost, our
 * code enforces caps", and "PostHog is telemetry and alerting, **not** the
 * control plane… a kill switch must work when PostHog is down or events are
 * sampled/delayed". Constitution invariant 17 restates it. Before this table,
 * the cap *numbers* existed in `packages/rules/signals.config.yaml` and the
 * meter did not, so the kill switches had nothing to read.
 *
 * Two properties are structural, not conventions:
 *
 * 1. **Append-only.** A cost that has been incurred is never revised. The
 *    database refuses `UPDATE` outright — see
 *    `migrations/0003_wave2_guards.sql`. `DELETE` stays open for the retention
 *    sweep of tech §2.1.
 * 2. **A cache hit is recorded at zero, never omitted.** §14.7 requirement (3):
 *    "replays served from `request_cache` are captured with `cache_hit: true`
 *    and zero cost, so cached work doesn't inflate spend numbers." Omitting the
 *    row instead would make re-used work vanish from the spend picture rather
 *    than show as free, so `cache_hit` with a non-zero cost is rejected.
 *
 * Nothing writes here yet: card `R2` wires the three instrumented wrappers of
 * invariant 25 to it, on success *and* on every failure path (remediation D2 —
 * both paid vendors bill for work performed, not for bytes we received).
 */
export const spendEvents = pgTable(
  'spend_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * §14.7's preview attribution rule, as a column pair: "the domain group is
     * reserved for claimed domains; ten strangers previewing `nike.com` is not
     * Nike-the-account costing us money. Preview events carry `target_domain`
     * as a plain property instead."
     *
     * Exactly one of these is set, mirroring `EventAttribution` in
     * `packages/core/src/contracts/analytics.ts`, which is a union of the same
     * two cases. The check constraint below is what makes every dollar
     * attributable to either an account or a preview target and never both.
     *
     * Deliberately **not** a foreign key. A cascade would let account deletion
     * (§14.6) erase money we actually spent, which is the opposite of
     * append-only; `SET NULL` would leave a row attributable to nobody and
     * break the check below. What §14.6 requires deleted is PII and
     * order-derived aggregates — a vendor invoice line is neither.
     */
    accountId: uuid('account_id'),
    previewTarget: text('preview_target'),
    vendor: spendVendorEnum('vendor').notNull(),
    /**
     * §14.7 — the LLM `call_type` (`distill | persona | seeds | judge | preview
     * | intent_gap | optimize_reco`) or the DataForSEO endpoint. Free text
     * rather than an enum because the endpoint side is the vendor's vocabulary,
     * not ours, and a new endpoint must not need a migration.
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
    // the very number the caps are computed from (§14.7 requirement 3).
    check('spend_events_cache_hit_is_free_ck', sql`${t.cacheHit} = false OR ${t.usdCost} = 0`),
    // §14.5 — "Account daily LLM spend > 10x its trailing-30-day median or >
    // hard dollar cap": a per-account window scan.
    index('spend_events_account_occurred_idx').on(t.accountId, t.occurredAt),
    // §14.5 — "Global DataForSEO daily spend > configured cap".
    index('spend_events_vendor_occurred_idx').on(t.vendor, t.occurredAt),
    // §14.5 — "Daily preview LLM spend > its own cap". Preview rows have no
    // account, so they are their own partial index.
    index('spend_events_preview_occurred_idx')
      .on(t.occurredAt)
      .where(sql`${t.accountId} IS NULL`),
  ],
)

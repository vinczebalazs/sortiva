import { and, eq, gte, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { spendEvents } from '../schema'
import type { AccountScope, SystemScope } from '../scope'

export type SpendEventRow = typeof spendEvents.$inferSelect

/**
 * main §14.5's spend caps read a counter; this is the write side of it. main
 * §14.7 draws the boundary the table exists to hold — "the §14.5 budget
 * auto-trips read spend from our own DB counters", and "PostHog is telemetry
 * and alerting, **not** the control plane… a kill switch must work when PostHog
 * is down or events are sampled/delayed" (constitution invariant 17).
 *
 * Append-only, and not by convention: migration `0003_wave2_guards.sql` makes
 * the database refuse `UPDATE` outright. A cost recorded wrongly is corrected
 * with a second row, so what we believed at the time stays readable.
 *
 * The scope is the account column, not a check beside it. Preview spend happens
 * before any account exists (§14.7's preview-attribution rule), so those rows
 * take a `SystemScope` and carry `preview_target` instead; the table's
 * `spend_events_attribution_ck` constraint is what makes every dollar
 * attributable to exactly one of the two.
 */
export async function appendSpendEvent(
  db: Db,
  scope: AccountScope | SystemScope,
  input: {
    /** Set only for preview spend, which has no account. */
    previewTarget?: string | null
    vendor: SpendEventRow['vendor']
    /** The LLM `call_type`, or the DataForSEO endpoint (§14.7). */
    callType: string
    usdCost: number
    cacheHit: boolean
    outcome: SpendEventRow['outcome']
    occurredAt?: Date
  },
): Promise<void> {
  await db.insert(spendEvents).values({
    accountId: 'accountId' in scope ? scope.accountId : null,
    previewTarget: input.previewTarget ?? null,
    vendor: input.vendor,
    callType: input.callType,
    // `numeric` crosses the wire as a string. Fixing the scale here rather than
    // letting `Number.prototype.toString` choose keeps a sub-cent cost out of
    // exponent notation, which is a different literal for the same number.
    usdCost: input.usdCost.toFixed(8),
    cacheHit: input.cacheHit,
    outcome: input.outcome,
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  })
}

/**
 * The window a cap is measured over, and whether calls that failed at the
 * vendor count towards it.
 *
 * `includeFailed` is not a preference the caller invents: every caller passes
 * the one product-wide answer, `COUNT_FAILED_VENDOR_CALLS`. It is a parameter
 * here because a repository must not reach into a policy constant, and because
 * an operator query may legitimately want the other total.
 */
export interface SpendWindow {
  /** Inclusive. */
  since: Date
  /** Exclusive, so consecutive windows never double-count a row on the boundary. */
  until: Date
  includeFailed: boolean
}

type SpendVendor = SpendEventRow['vendor']

function windowFilter(window: SpendWindow) {
  return and(
    gte(spendEvents.occurredAt, window.since),
    lt(spendEvents.occurredAt, window.until),
    window.includeFailed ? undefined : eq(spendEvents.outcome, 'succeeded'),
  )
}

/**
 * `numeric` arrives as a string over the wire and an empty window sums to
 * `NULL`, so both are resolved in SQL: every caller here is comparing against a
 * dollar cap and a string or a null would compare wrongly rather than loudly.
 */
const totalUsd = sql<number>`coalesce(sum(${spendEvents.usdCost}), 0)::float8`

/** What one account has spent with one vendor inside the window. */
export async function sumAccountVendorSpend(
  db: Db,
  scope: AccountScope,
  vendor: SpendVendor,
  window: SpendWindow,
): Promise<number> {
  const [row] = await db
    .select({ total: totalUsd })
    .from(spendEvents)
    .where(
      and(
        eq(spendEvents.accountId, scope.accountId),
        eq(spendEvents.vendor, vendor),
        windowFilter(window),
      ),
    )
  return row?.total ?? 0
}

/**
 * The same sum across every account and the preview funnel together, for the
 * caps whose ceiling is a vendor invoice rather than one store's behaviour.
 */
export async function sumVendorSpend(
  db: Db,
  _scope: SystemScope,
  vendor: SpendVendor,
  window: SpendWindow,
): Promise<number> {
  const [row] = await db
    .select({ total: totalUsd })
    .from(spendEvents)
    .where(and(eq(spendEvents.vendor, vendor), windowFilter(window)))
  return row?.total ?? 0
}

/**
 * Everything the logged-out preview cost inside the window, whichever vendor
 * it went to. A row with no account is preview spend by construction — the
 * table's attribution constraint allows nothing else — so this deliberately
 * does not filter on vendor: a preview that one day pays a second vendor must
 * land inside the preview cap rather than escape it.
 */
export async function sumPreviewSpend(
  db: Db,
  _scope: SystemScope,
  window: SpendWindow,
): Promise<number> {
  const [row] = await db
    .select({ total: totalUsd })
    .from(spendEvents)
    .where(and(isNull(spendEvents.accountId), windowFilter(window)))
  return row?.total ?? 0
}

/** One row per UTC day on which the account spent anything with the vendor. */
export interface DailySpend {
  /** `YYYY-MM-DD`, UTC. */
  day: string
  usdCost: number
}

/**
 * The account's spending history, a day at a time, for the rule that catches a
 * store spending far more than *it* normally does. Days with no spend produce
 * no row: a store that works three days a week has a typical day's cost of
 * whatever it spends when it works, not zero.
 */
export async function dailyAccountVendorSpend(
  db: Db,
  scope: AccountScope,
  vendor: SpendVendor,
  window: SpendWindow,
): Promise<DailySpend[]> {
  const day = sql<string>`((${spendEvents.occurredAt} AT TIME ZONE 'UTC')::date)::text`
  const rows = await db
    .select({ day, total: totalUsd })
    .from(spendEvents)
    .where(
      and(
        eq(spendEvents.accountId, scope.accountId),
        eq(spendEvents.vendor, vendor),
        windowFilter(window),
      ),
    )
    .groupBy(day)
    .orderBy(day)
  return rows.map((r) => ({ day: r.day, usdCost: r.total }))
}

/**
 * Which accounts spent anything with the vendor inside the window — the list
 * the cap sweep walks. Scanning every account instead would make the sweep's
 * cost grow with the customer base while the answer for almost all of them is
 * "spent nothing today".
 */
export async function accountsWithVendorSpend(
  db: Db,
  _scope: SystemScope,
  vendor: SpendVendor,
  window: SpendWindow,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ accountId: spendEvents.accountId })
    .from(spendEvents)
    .where(
      and(
        isNotNull(spendEvents.accountId),
        eq(spendEvents.vendor, vendor),
        windowFilter(window),
      ),
    )
  return rows.flatMap((r) => (r.accountId === null ? [] : [r.accountId]))
}

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

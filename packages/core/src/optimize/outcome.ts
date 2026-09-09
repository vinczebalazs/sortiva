import type { AnalyticsEvent, EventAttribution } from '../contracts/analytics'
import { median } from '../ops'

/**
 * What became of a page after the merchant said they made the changes we
 * suggested — and, just as often, the reason there is nothing we can honestly
 * say about it.
 *
 * Two rules shape everything here and are worth stating before the code.
 *
 * **Nothing is absolute.** Every comparison is the page against its own
 * previous four weeks, and the one place a number from outside the page enters
 * — the traffic floor below which a ranking move is noise — is the store's own
 * middle page rather than a figure that would suit a large store and exclude
 * every small one. Forty clicks a month is a triumph for one shop and a
 * disaster for another, and a verdict that could not tell them apart would be
 * worse than no verdict.
 *
 * **"We cannot measure this" is not "this did badly."** A page taken down, a
 * store with no search data, a page nobody was shown in the weeks before the
 * work: each produces a record saying so and no label at all. Recording any of
 * them as a decline would tell a merchant their work made things worse, on
 * evidence that says nothing of the kind.
 */

/** One page's Search Console figures over one 28-day window. */
export interface OptimizeWindowTotals {
  readonly clicks: number
  readonly impressions: number
  /** Impression-weighted mean position. Null when the page was never shown. */
  readonly position: number | null
}

export interface OptimizeOutcomeConfig {
  readonly improved_position_delta_min: number
  readonly improved_ctr_relative_delta_min: number
  readonly impressions_not_collapsed_ratio_min: number
}

export type OptimizeOutcomeLabel = 'improved' | 'neutral' | 'worse'

/**
 * Why a booked measurement produced no verdict. Each is a fact about what we
 * could see, never about how the merchant's work went.
 */
export type OptimizeUnmeasurableReason =
  /** The store no longer serves the address, or we never held a row for it. Nothing to look at. */
  | 'page_no_longer_in_store'
  /** No Search Console grant, so there is no measurement to make and never will be. */
  | 'search_console_not_connected'
  /** The store's search history has not caught up with the end of the window yet. */
  | 'search_data_incomplete'
  /** The page had no impressions at all in the four weeks before the work, so there is nothing to compare against. */
  | 'no_baseline'
  /** The row was never marked applied, so no 28 days were ever counted from anything. */
  | 'not_applied'
  /** Published past the quality gate on the merchant's insistence: kept out of everything the product learns from. */
  | 'published_via_override'

/**
 * The key the measurement writes under inside `opportunities.outcome_json`.
 *
 * Namespaced for the reason the repair log next door already gives: a repair
 * and a measurement can both land on one opportunity row, and each needs
 * somewhere of its own so neither overwrites the other.
 */
export const OPTIMIZE_OUTCOME_KEY = 'measurement'

export interface OptimizeOutcomeMeasured {
  readonly measured: true
  readonly action: 'optimize'
  readonly label: OptimizeOutcomeLabel
  /** The address measured, as the inventory spells it. */
  readonly pageUrl: string
  /** Inclusive `YYYY-MM-DD` bounds of the four weeks before the work, and the four weeks after. */
  readonly beforeWindow: { readonly startDate: string; readonly endDate: string }
  readonly afterWindow: { readonly startDate: string; readonly endDate: string }
  readonly before: OptimizeWindowTotals
  readonly after: OptimizeWindowTotals
  /**
   * The store's own middle page by impressions over the after window — the
   * yardstick the ranking route is held to, recorded so the verdict can be
   * re-read later without recomputing the store's whole month.
   */
  readonly storeMedianImpressions: number | null
  readonly measuredAt: string
}

export interface OptimizeOutcomeUnmeasurable {
  readonly measured: false
  readonly action: 'optimize'
  readonly reason: OptimizeUnmeasurableReason
  readonly pageUrl: string
  readonly measuredAt: string
}

export type OptimizeOutcomeRecord = OptimizeOutcomeMeasured | OptimizeOutcomeUnmeasurable

/**
 * Builds what goes in the row.
 *
 * A measured outcome also writes `label`, `before` and `after` at the top
 * level, because that is where the drawer and the performance table already
 * look: they were built against this column before anything wrote to it. An
 * unmeasurable one deliberately writes none of those three, so both screens
 * fall back to having no verdict rather than showing one we cannot stand
 * behind — which is the difference the merchant reads.
 *
 * `before` and `after` at the top level are **clicks**. The drawer renders them
 * as a bare "23 → 41" with no unit, and clicks is the number a merchant means
 * by "did it work"; position and impressions are in the record beside them.
 */
export function optimizeOutcomeJson(record: OptimizeOutcomeRecord): Record<string, unknown> {
  if (!record.measured) return { [OPTIMIZE_OUTCOME_KEY]: record }
  return {
    label: record.label,
    before: record.before.clicks,
    after: record.after.clicks,
    [OPTIMIZE_OUTCOME_KEY]: record,
  }
}

/** Reads a measurement back out, ignoring a repair log or anything else written beside it. */
export function readOptimizeOutcome(outcome: unknown): OptimizeOutcomeRecord | undefined {
  if (!outcome || typeof outcome !== 'object') return undefined
  const record = (outcome as Record<string, unknown>)[OPTIMIZE_OUTCOME_KEY]
  if (!record || typeof record !== 'object') return undefined
  return record as OptimizeOutcomeRecord
}

/** Clicks per impression, or null where the page was never shown and the ratio would be a division by nothing. */
export function ctrOf(totals: OptimizeWindowTotals): number | null {
  return totals.impressions ? totals.clicks / totals.impressions : null
}

/**
 * The store's own middle page by impressions.
 *
 * Pages the store was never shown for are left out, the same way the signal
 * detectors' baseline leaves them out: counting silent pages towards the middle
 * would drag the yardstick down until every page cleared it, which is the same
 * as having no yardstick.
 */
export function storeMedianImpressions(
  pages: readonly OptimizeWindowTotals[],
): number | null {
  return median(pages.filter((page) => Boolean(page.impressions)).map((page) => page.impressions))
}

/**
 * The verdict on one page, from its own two windows.
 *
 * Two routes to `improved`, and each carries the guard that stops the same
 * arithmetic producing a false win:
 *
 *  - **It ranks better.** The mean position improved by at least the configured
 *    number of places *and* the page cleared the store's own median impressions
 *    over the same weeks. Without that floor a page shown eleven times could
 *    move from position 40 to position 12 on one lucky day and be recorded as a
 *    success the planner then learns from.
 *  - **More of the people shown it clicked.** Click-through rose by at least
 *    the configured share of what it was, and impressions did not collapse
 *    underneath it. A page losing four fifths of its impressions almost always
 *    posts a better click-through, because what it loses first is the searches
 *    it ranked worst for — which is a page doing worse, described as a win.
 *
 * The mirror of each is `worse`. Anything else is `neutral`: most work moves
 * nothing much, and saying so is more useful than forcing every page into a
 * winner or a loser.
 *
 * `storeMedian` of null means the store has no page with impressions to be a
 * middle of, which closes the ranking route rather than opening it.
 */
export function optimizeOutcomeLabel(input: {
  readonly before: OptimizeWindowTotals
  readonly after: OptimizeWindowTotals
  readonly storeMedian: number | null
  readonly config: OptimizeOutcomeConfig
}): OptimizeOutcomeLabel {
  const { before, after, storeMedian, config } = input

  const positionDelta =
    before.position !== null && after.position !== null ? before.position - after.position : null
  const clearsStoreMiddle = storeMedian !== null && after.impressions >= storeMedian

  const beforeCtr = ctrOf(before)
  const afterCtr = ctrOf(after)
  const ctrRelativeDelta =
    beforeCtr && afterCtr !== null ? (afterCtr - beforeCtr) / beforeCtr : null

  const impressionsHeld =
    after.impressions >= before.impressions * config.impressions_not_collapsed_ratio_min

  const rankImproved =
    positionDelta !== null && positionDelta >= config.improved_position_delta_min && clearsStoreMiddle
  const ctrImproved =
    ctrRelativeDelta !== null &&
    ctrRelativeDelta >= config.improved_ctr_relative_delta_min &&
    impressionsHeld
  if (rankImproved || ctrImproved) return 'improved'

  const rankWorsened =
    positionDelta !== null && -positionDelta >= config.improved_position_delta_min
  const ctrWorsened =
    ctrRelativeDelta !== null && -ctrRelativeDelta >= config.improved_ctr_relative_delta_min
  // Impressions falling through the collapse floor is a decline on its own
  // terms: whatever the page's click-through did, far fewer people are being
  // shown it than before the work.
  if (rankWorsened || ctrWorsened || !impressionsHeld) return 'worse'

  return 'neutral'
}

export const OPPORTUNITY_OUTCOME_MEASURED_EVENT = 'opportunity_outcome_measured'

/**
 * The analytics event for a measurement that produced a verdict.
 *
 * Two enumerated names and nothing else — no address, no numbers of the
 * merchant's own. There is deliberately no event for a measurement that could
 * not be made: the vendor's copy of this exists to show how the product's
 * advice performs, and a row saying "the page was deleted" would be counted
 * into that distribution as though it were a result.
 */
export function opportunityOutcomeMeasured(
  attribution: EventAttribution,
  outcome: { readonly actionType: string; readonly label: OptimizeOutcomeLabel },
): AnalyticsEvent {
  return {
    event: OPPORTUNITY_OUTCOME_MEASURED_EVENT,
    attribution,
    properties: { action_type: outcome.actionType, label: outcome.label },
  }
}

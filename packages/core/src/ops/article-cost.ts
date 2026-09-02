/**
 * What one article actually cost us, stamped once when it ships.
 *
 * The point is the word *all-in*. Model spend alone is the number that is easy
 * to get and the one that misleads: an article also carries the search-data
 * reads that found its topic and checked who else ranks for it. "Cost per
 * domain" and "cost per published article" are only honest if both halves are
 * in the total, so this event carries the split as well as the sum — a
 * dashboard that shows only one of them is then visibly showing only one.
 *
 * Telemetry, not enforcement. The caps read our own ledger; this is what makes
 * the money legible afterwards.
 */

import type { AnalyticsEvent, EventAttribution } from '../contracts/analytics'

export const ARTICLE_COST_FINALIZED_EVENT = 'article_cost_finalized'

export interface ArticleCostBreakdown {
  /** Which article, so the event joins to the row without carrying a word of it. */
  articleId: string
  /** Every model call made for this article — drafting, judging, the one repair loop. */
  llmUsdCost: number
  /** Every paid search-data read attributable to it. */
  seoUsdCost: number
  /** How many model calls went into it, so an unusually expensive article can be explained. */
  llmCallCount: number
  /** Whether the draft needed its one repair pass. */
  repaired: boolean
  /** True when the merchant published over a failing quality verdict, so calibration can exclude it. */
  publishedViaOverride: boolean
}

/**
 * Rounds to the cent a vendor invoice is denominated in. Sub-cent precision is
 * kept in the ledger, which is what the caps read; carrying it into a dashboard
 * only makes a chart harder to read.
 */
function usd(amount: number): number {
  return Math.round(amount * 100) / 100
}

export function articleCostFinalized(
  attribution: EventAttribution,
  cost: ArticleCostBreakdown,
): AnalyticsEvent {
  return {
    event: ARTICLE_COST_FINALIZED_EVENT,
    attribution,
    properties: {
      article_id: cost.articleId,
      // The all-in number. Never LLM-only: a cost-per-article chart missing the
      // search-data half understates every article by a different amount.
      usd_total: usd(cost.llmUsdCost + cost.seoUsdCost),
      usd_llm: usd(cost.llmUsdCost),
      usd_seo: usd(cost.seoUsdCost),
      llm_call_count: cost.llmCallCount,
      repaired: cost.repaired,
      published_via_override: cost.publishedViaOverride,
    },
  }
}

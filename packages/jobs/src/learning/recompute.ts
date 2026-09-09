import {
  accountAttribution,
  aggregatePatterns,
  labelStore,
  labelWindows,
  normalisePageUrl,
  ratedLabels,
  type ArticleLabelConfig,
  type ArticleLabelFacts,
  type LabelWindowTotals,
  type Logger,
  type PatternConfig,
  type PosthogCapture,
} from '@sortiva/core'
import {
  accountScope,
  articleLabelInputs,
  gscPageTotals,
  latestGscDay,
  patternLearningInputs,
  savePatternStats,
  saveArticleLabels,
  type Db,
} from '@sortiva/db'
import { rules } from '@sortiva/rules'
import type pg from 'pg'
import { withAccountLock } from '../runtime/lock'
import { runtimeLogger } from '../runtime/logging'

/**
 * The weekly look back at what the store published, and what it says about the
 * kind of thing worth publishing next.
 *
 * Two passes, in this order and for a reason. The first asks what became of
 * each article — a winner, an also-ran, an underperformer, or nothing at all
 * because we are not entitled to an opinion about it yet. The second rolls
 * those verdicts up into "articles like this one tend to work here", which is
 * what tilts the calendar's choices the following month.
 *
 * The order is load-bearing: the second pass reads what the first wrote, so
 * running them apart would spend a week learning from last week's verdicts for
 * no reason. They are one job for that reason and not for convenience.
 *
 * **Nothing here is charged for and nothing leaves the building.** Both passes
 * are reads of our own tables and writes to our own tables, so a redelivered
 * job costs a few queries. Re-running the same week corrects rather than
 * duplicates: a verdict is keyed on the article and the window, and the
 * learned picture is replaced wholesale.
 */

export interface LearningRecomputeDeps {
  readonly db: Db
  readonly pool: pg.Pool
  readonly capture?: Pick<PosthogCapture, 'capture'>
  readonly now?: () => Date
  readonly logger?: Logger
}

export type LearningRecomputeOutcome =
  | {
      readonly status: 'recomputed'
      /** Verdicts stored, including the refusals. */
      readonly labelled: number
      /** Of those, the ones the store was willing to judge. */
      readonly rated: number
      /** Axis-values that cleared the activation minimum and now carry a multiplier. */
      readonly patterns: number
      readonly window: { readonly startDate: string; readonly endDate: string }
    }
  | {
      /**
       * The store has no Search Console history at all, so there is nothing to
       * judge anything by. Not a failure: main §7.11's Limited Intelligence
       * mode is a supported state, and the loop is specified to function
       * without search data — it simply learns nothing.
       */
      readonly status: 'no_search_data'
    }

export const ARTICLE_LABELED_EVENT = 'article_labeled'

/** One article's figures over one window, from the store's page totals. */
function totalsFor(
  rows: readonly { key: string; clicks: number; impressions: number; position: number | null }[],
  url: string | null,
): LabelWindowTotals {
  if (!url) return { clicks: 0, impressions: 0, position: null }
  const wanted = normalisePageUrl(url)
  const row = rows.find((candidate) => normalisePageUrl(candidate.key) === wanted)
  return row
    ? { clicks: row.clicks, impressions: row.impressions, position: row.position }
    : // Google reported nothing for this address over the window. Zero shows and
      // zero clicks is what happened, and it is not the same as "no position":
      // a null position means we cannot say where it ranked, which closes the
      // routes that need one rather than opening a route that punishes it.
      { clicks: 0, impressions: 0, position: null }
}

function labelConfig(defaults: ReturnType<typeof rules>['defaults']): ArticleLabelConfig {
  const labels = defaults.learning.labels
  return {
    maturityDays: labels.maturity_days,
    winnerClicksStoreMedianMultipleMin: labels.winner_clicks_store_median_multiple_min,
    winnerPositionImprovementMin: labels.winner_position_improvement_min,
    underperformerClicksStoreMedianMultipleMax:
      labels.underperformer_clicks_store_median_multiple_max,
    underperformerPositionMin: labels.underperformer_position_min,
    underperformerAgeDaysMin: labels.underperformer_age_days_min,
  }
}

function patternConfig(defaults: ReturnType<typeof rules>['defaults']): PatternConfig {
  const patterns = defaults.learning.patterns
  return {
    activationMinRated: patterns.activation_min_rated,
    dominanceShareMin: patterns.dominance_share_min,
    winnerDominantMultiplier: patterns.winner_dominant_multiplier,
    underperformerDominantMultiplier: patterns.underperformer_dominant_multiplier,
    mixedMultiplier: patterns.mixed_multiplier,
    clampMin: patterns.multiplier_clamp_min,
    clampMax: patterns.multiplier_clamp_max,
    dimensions: patterns.dimensions,
  }
}

const DAY_MS = 86_400_000

/**
 * Recomputes one store's verdicts and its learned picture.
 *
 * **Takes the store's lock and waits for it rather than backing off.** Both
 * passes write derived rows for the account, so they must not run beside a
 * generation cycle writing the same store's articles. Waiting rather than
 * skipping is the right trade for a weekly job: a store busy at the moment the
 * sweep fires would otherwise go a full week unjudged, and the wait is bounded
 * — a lock held longer than any step should take fails loudly and retries on
 * the normal backoff.
 */
export async function recomputeLearningForAccount(
  deps: LearningRecomputeDeps,
  accountId: string,
): Promise<LearningRecomputeOutcome> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const config = rules().defaults
  const scope = accountScope(accountId)

  return withAccountLock(deps.pool, accountId, async () => {
    // Anchored on the newest day the store actually has search data for, not on
    // today. Google reports two to three days behind, so anchoring on today
    // would measure a short window against a full one and read the missing days
    // as a collapse.
    const latest = await latestGscDay(deps.db, scope)
    if (!latest) {
      log.info('learning_recompute_skipped', { accountId, reason: 'no_search_data' })
      return { status: 'no_search_data' as const }
    }

    const windows = labelWindows(latest)
    const [currentRows, priorRows, inputs] = await Promise.all([
      gscPageTotals(deps.db, scope, windows.current),
      gscPageTotals(deps.db, scope, windows.prior),
      articleLabelInputs(deps.db, scope),
    ])

    const facts: ArticleLabelFacts[] = inputs.map((input) => ({
      ...input,
      current: totalsFor(currentRows, input.publishedUrl),
      prior: totalsFor(priorRows, input.publishedUrl),
    }))

    const { results } = labelStore(facts, labelConfig(config), now.toISOString())
    const labelled = await saveArticleLabels(deps.db, scope, windows.current, results, now)

    const rated = ratedLabels(results)
    for (const verdict of rated) {
      // Main §9.6.9's event: the verdict and how old the article was, so the
      // saved insight can watch a store's mix of verdicts move. No article id,
      // no title, no click count — invariant 26.
      //
      // Emitted once per judged article per run. The queue is at-least-once, so
      // a redelivered job re-emits; this is telemetry rather than the control
      // plane (invariant 17) and the distribution it feeds tolerates a repeated
      // week better than the alternative would tolerate a missed one.
      deps.capture?.capture({
        event: ARTICLE_LABELED_EVENT,
        attribution: accountAttribution(accountId),
        properties: { label: verdict.label, age_days: verdict.ageDays },
      })
    }

    const since = new Date(now.getTime() - config.learning.patterns.recency_window_days * DAY_MS)
    const learning = await patternLearningInputs(deps.db, scope, since)
    const patterns = await savePatternStats(
      deps.db,
      scope,
      aggregatePatterns(learning, patternConfig(config)),
      now,
    )

    log.info('learning_recompute_complete', {
      accountId,
      labelled,
      rated: rated.length,
      patterns,
      windowStart: windows.current.startDate,
      windowEnd: windows.current.endDate,
    })

    return {
      status: 'recomputed' as const,
      labelled,
      rated: rated.length,
      patterns,
      window: windows.current,
    }
  })
}

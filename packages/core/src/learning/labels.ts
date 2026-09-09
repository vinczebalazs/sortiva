import { median } from '../ops/spend-caps'
import { comparedWindows } from '../search/performance'

/**
 * What became of each article we published for a store — and, for a good many
 * of them, the reason the honest answer is "we are not going to say".
 *
 * Two rules shape all of it and are worth stating before the code.
 *
 * **Nothing is judged early.** Search rankings settle over weeks, so an
 * article gets no verdict at all until it has been live for the configured
 * maturity period. Before that it is not a poor performer; it is a page
 * Google has not finished forming an opinion about, and grading it would
 * teach the planner a lesson drawn from noise.
 *
 * **Nothing is absolute.** "Did well" means well *for this store*: every
 * threshold here is a multiple of the store's own middle article, never a
 * click count. Forty clicks a month is a triumph for a niche shop and a
 * failure for a large one, and a rule that could not tell them apart would
 * hand the small shop a page of underperformers and the large one a page of
 * winners, both wrong.
 *
 * **Why there is no function here that grades one article.** The store's
 * middle article is the yardstick, and which articles are allowed to *be* the
 * middle is the same question as which articles may be graded. Splitting those
 * apart would leave a caller free to work out a baseline over articles that
 * should never have counted — an article the merchant published over our
 * objection, one still too young, one whose address we were never told — and
 * then grade against it. So `labelStore` is the only door: it gates the set,
 * builds the baseline out of what survives, and grades that same set. An
 * excluded article cannot receive a verdict and cannot influence anybody
 * else's, and neither of those depends on a caller remembering to filter.
 *
 * Everything here is pure. Facts and numbers in, verdicts out; no database, no
 * clock, no model, and every threshold arrives as a parameter.
 */

/** The four verdicts. `unrated` is a real answer, not a missing one. */
export type ArticleLabel = 'winner' | 'neutral' | 'underperformer' | 'unrated'

/**
 * Why an article is not graded. Each is a fact about what we may look at,
 * never about how the article did.
 */
export type LabelExclusion =
  /** Nothing is live for Google to have an opinion about. */
  | 'not_published'
  /** Live for less than the maturity period. Rankings have not settled. */
  | 'too_young'
  /** Published past the quality bar on the merchant's insistence, so its performance is not ours to reason from. */
  | 'published_via_override'
  /** A factual repair is queued against it; what we would be grading is a page we already know is wrong. */
  | 'repair_pending'
  /** Downloaded by the merchant and published somewhere they never told us, so no search data is attributable to it. Absence of data is not failure. */
  | 'export_url_unconfirmed'

/** One article's Search Console figures over one window. */
export interface LabelWindowTotals {
  readonly clicks: number
  readonly impressions: number
  /** Impression-weighted mean position. Null when the article was never shown. */
  readonly position: number | null
}

/** What we know about one published article at the moment the weekly recompute asks. */
export interface ArticleLabelFacts {
  readonly articleId: string
  readonly published: boolean
  /** When it went live. Null for anything not published, which is its own exclusion. */
  readonly publishedAt: string | null
  readonly publishedViaOverride: boolean
  /** How it reached the merchant: posted by us, or downloaded by them. */
  readonly delivery: 'auto' | 'export'
  /** The address search performance is attributed by. Null for an export article whose merchant never confirmed where they put it. */
  readonly publishedUrl: string | null
  /** An open repair opportunity stands against this article. */
  readonly repairPending: boolean
  /** The trailing window. */
  readonly current: LabelWindowTotals
  /** The equally long window immediately before it, which is what a position change is measured against. */
  readonly prior: LabelWindowTotals
}

export interface ArticleLabelConfig {
  readonly maturityDays: number
  readonly winnerClicksStoreMedianMultipleMin: number
  readonly winnerPositionImprovementMin: number
  readonly underperformerClicksStoreMedianMultipleMax: number
  readonly underperformerPositionMin: number
  readonly underperformerAgeDaysMin: number
}

/**
 * The store measured against itself: the middle article of everything we are
 * prepared to grade this week.
 *
 * Null medians mean the store has nothing gradeable yet — a new account, or one
 * whose every article is excluded. Both close every route to a verdict rather
 * than opening one, so an empty store produces neutrals rather than winners.
 */
export interface StoreLabelBaseline {
  readonly medianClicks: number | null
  readonly medianImpressions: number | null
  /** How many articles the medians were taken over — the same count §9.6.3's pattern activation later needs. */
  readonly ratedN: number
}

export interface RatedArticleLabel {
  readonly articleId: string
  readonly label: 'winner' | 'neutral' | 'underperformer'
  readonly ageDays: number
  readonly current: LabelWindowTotals
  readonly prior: LabelWindowTotals
}

export interface UnratedArticleLabel {
  readonly articleId: string
  readonly label: 'unrated'
  /** Every reason at once, in a fixed order, so two runs of the same week report the same thing. */
  readonly excludedBecause: readonly LabelExclusion[]
  /** Null when the article was never published and so has no age. */
  readonly ageDays: number | null
}

export type ArticleLabelResult = RatedArticleLabel | UnratedArticleLabel

export interface StoreLabelling {
  readonly baseline: StoreLabelBaseline
  readonly results: readonly ArticleLabelResult[]
}

const DAY_MS = 86_400_000

/**
 * Whole days live. Null when the article was never published.
 *
 * A published-at in the future — a clock skew, or a scheduled publish recorded
 * early — counts as zero days old, which keeps it too young rather than
 * wrapping round to an enormous age that would clear every gate.
 */
export function articleAgeDays(publishedAt: string | null, at: string): number | null {
  if (publishedAt === null) return null
  const elapsed = Date.parse(at) - Date.parse(publishedAt)
  if (!Number.isFinite(elapsed)) return null
  return Math.max(0, Math.floor(elapsed / DAY_MS))
}

/**
 * Every reason this article may not be graded, in a fixed order.
 *
 * All of them rather than the first found, for the same reason the refresh
 * rules collect all of theirs: a report that names one reason this week and a
 * different one next week reads like the article kept failing new checks, when
 * in fact nothing changed.
 */
export function labelExclusions(
  facts: ArticleLabelFacts,
  config: ArticleLabelConfig,
  at: string,
): readonly LabelExclusion[] {
  const exclusions: LabelExclusion[] = []

  if (!facts.published) exclusions.push('not_published')

  const ageDays = articleAgeDays(facts.publishedAt, at)
  if (ageDays === null || ageDays < config.maturityDays) exclusions.push('too_young')

  if (facts.publishedViaOverride) exclusions.push('published_via_override')
  if (facts.repairPending) exclusions.push('repair_pending')

  // An article we posted ourselves knows its own address. One the merchant
  // downloaded only has an address if they came back and told us, and until
  // they do there is no row in Search Console we can honestly call this
  // article's.
  if (facts.delivery === 'export' && !facts.publishedUrl) {
    exclusions.push('export_url_unconfirmed')
  }

  return exclusions
}

/**
 * The store's own middle, over the articles handed in.
 *
 * Not exported alone on purpose — see the note at the top of the file. The
 * caller that could pick the set is the caller that could poison it.
 *
 * Articles the store was never shown for are counted, not skipped. They are
 * part of what this store's output looks like, and dropping them would lift
 * the middle until only the store's very best articles cleared it — which is
 * the opposite of judging a store against itself.
 */
function storeLabelBaseline(rated: readonly LabelWindowTotals[]): StoreLabelBaseline {
  return {
    medianClicks: median(rated.map((totals) => totals.clicks)),
    medianImpressions: median(rated.map((totals) => totals.impressions)),
    ratedN: rated.length,
  }
}

/**
 * The verdict on one gradeable article against a baseline built from its own
 * store.
 *
 * Two routes to `winner`:
 *
 *  - **It gets far more clicks than this store's typical article.** At least
 *    the configured multiple of the store's middle. The multiple is only
 *    meaningful if there is a middle to multiply: a store whose median article
 *    gets no clicks at all has no baseline, and `2 × 0` would otherwise crown
 *    every silent article in it a winner.
 *  - **It climbed, and enough people saw it climb.** The mean position
 *    improved by at least the configured number of places *and* the article
 *    was shown more than the store's middle article over the same weeks.
 *    Without that floor an article shown nine times could move from position
 *    40 to 20 on one lucky day and be recorded as a success the planner then
 *    learns from.
 *
 * `underperformer` is the heavier claim and carries a heavier burden: it needs
 * an older article than the maturity gate asks for, clicks below a fraction of
 * the store's middle, *and* a position past the point where a page is
 * realistically findable. An article with no position at all — never shown —
 * fails that last test and stays `neutral`, because we cannot see it rather
 * than because it did badly.
 *
 * Where both verdicts could be argued, `winner` wins. An article whose ranking
 * jumped and whose traffic has not caught up yet is a story about improvement,
 * and telling the merchant it is a failure would be false at the moment it was
 * least true.
 */
function verdict(
  facts: ArticleLabelFacts,
  ageDays: number,
  baseline: StoreLabelBaseline,
  config: ArticleLabelConfig,
): 'winner' | 'neutral' | 'underperformer' {
  const { current, prior } = facts
  const { medianClicks, medianImpressions } = baseline

  // The store's middle article, named rather than used inline so the "is there
  // a baseline at all" question is asked of the store and not of a click count.
  const middle = medianClicks
  const clicksToWin =
    middle === null || middle === 0 ? null : config.winnerClicksStoreMedianMultipleMin * middle
  const beatsStoreClicks = clicksToWin !== null && current.clicks >= clicksToWin

  const positionImprovement =
    prior.position !== null && current.position !== null ? prior.position - current.position : null
  const climbed =
    positionImprovement !== null &&
    positionImprovement >= config.winnerPositionImprovementMin &&
    medianImpressions !== null &&
    current.impressions > medianImpressions

  if (beatsStoreClicks || climbed) return 'winner'

  const oldEnoughToFail = ageDays >= config.underperformerAgeDaysMin
  const wellBelowStoreClicks =
    medianClicks !== null &&
    current.clicks < config.underperformerClicksStoreMedianMultipleMax * medianClicks
  const buriedInResults =
    current.position !== null && current.position > config.underperformerPositionMin

  if (oldEnoughToFail && wellBelowStoreClicks && buriedInResults) return 'underperformer'

  return 'neutral'
}

/**
 * The week's verdicts for one store, and the baseline they were reached
 * against.
 *
 * This is the only way to obtain a verdict. It gates the store's articles,
 * builds the baseline from the survivors alone, then grades those same
 * survivors — so the arithmetic never sees an article it was not allowed to
 * see, in either role.
 *
 * Every article handed in comes back with an answer. An excluded one is
 * `unrated` and carries its reasons; nothing is silently dropped, because a
 * missing row and a deliberate refusal look identical to whatever reads this
 * next.
 *
 * Order is preserved, so a caller can pair the results with what it passed in.
 */
export function labelStore(
  articles: readonly ArticleLabelFacts[],
  config: ArticleLabelConfig,
  at: string,
): StoreLabelling {
  const gated = articles.map((facts) => ({
    facts,
    ageDays: articleAgeDays(facts.publishedAt, at),
    exclusions: labelExclusions(facts, config, at),
  }))

  const gradeable = gated.filter((entry) => entry.exclusions.length === 0)
  const baseline = storeLabelBaseline(gradeable.map((entry) => entry.facts.current))

  const results = gated.map((entry): ArticleLabelResult => {
    if (entry.exclusions.length > 0 || entry.ageDays === null) {
      return {
        articleId: entry.facts.articleId,
        label: 'unrated',
        excludedBecause: entry.exclusions,
        ageDays: entry.ageDays,
      }
    }
    return {
      articleId: entry.facts.articleId,
      label: verdict(entry.facts, entry.ageDays, baseline, config),
      ageDays: entry.ageDays,
      current: entry.facts.current,
      prior: entry.facts.prior,
    }
  })

  return { baseline, results }
}

/** Narrowing helper: the graded articles, which are the only ones anything downstream may learn from. */
export function ratedLabels(
  results: readonly ArticleLabelResult[],
): readonly RatedArticleLabel[] {
  return results.filter((result): result is RatedArticleLabel => result.label !== 'unrated')
}

/**
 * The two windows a recompute measures over: the trailing one, and the equally
 * long one behind it.
 *
 * Anchored on the newest day the store actually has Search Console data for,
 * not on today. Google reports two to three days behind, so anchoring on today
 * would compare a short window against a full one and read the missing days as
 * a collapse.
 */
export function labelWindows(lastGscDay: string): {
  readonly current: { readonly startDate: string; readonly endDate: string }
  readonly prior: { readonly startDate: string; readonly endDate: string }
} {
  return comparedWindows(lastGscDay, '28d')
}

import { existingPageExpectedGain } from '../opportunities/scoring'
import { expectedCtrAt, type CtrCurve } from '../search/ctr-curve'

/**
 * When one of our own published articles may be rewritten, and how much
 * rewriting it is worth.
 *
 * The product writes an article once and then, if it is nearly good enough to
 * win, writes it again rather than writing a second article about the same
 * thing. This file decides which articles that applies to. Everything here is
 * pure — facts and numbers in, an answer out — so a rule can be tested against
 * a store that does not exist, and nothing here can reach a database, a model
 * or a clock. Every threshold arrives as a parameter (invariant 9).
 *
 * The rules are deliberately conservative in both directions. A rewrite costs
 * a calendar day that would otherwise cover something the store has never
 * written about at all, so an article has to be close enough to the front page
 * for the rewrite to plausibly move it, and carry enough traffic for the move
 * to be worth anything. And it costs the merchant's trust, so we do not do it
 * to an article they published over our objection, nor to one that is already
 * queued for a factual repair.
 */

/** Why an article may not be rewritten right now. Every one of these is a reason, never a bare `false`. */
export type RefreshBlocker =
  /** Rewritten too recently. Google has not finished re-reading the last one. */
  | 'within_cooldown'
  /** Not close enough to the front page for a rewrite to move it, or already high enough that there is nothing to gain. */
  | 'position_outside_band'
  /** Nobody is being shown this page often enough for a better version to matter. */
  | 'impressions_below_store_median'
  /** A factual repair is already queued for this article; repairing it first is cheaper and comes first. */
  | 'repair_pending'
  /** The merchant published it over our quality objection, so its performance is not ours to reason from. */
  | 'published_via_override'
  /** Nothing is live for Google to have an opinion about. */
  | 'not_published'

/**
 * What we know about one of our articles at the moment the question is asked.
 *
 * Position and impressions are nullable because a store with no Search Console
 * connection has neither, and the product still has to answer. A missing
 * measurement is treated as a failure of the measured rule rather than as a
 * pass: we do not rewrite an article on the assumption that it is probably
 * doing well.
 */
export interface RefreshCandidateFacts {
  readonly articleId: string
  readonly published: boolean
  readonly publishedViaOverride: boolean
  /** When this article was last rewritten, if ever. Null means never. */
  readonly lastRefreshedAt: string | null
  /** An open repair opportunity stands against this article. */
  readonly repairPending: boolean
  /** Mean Google position over the measurement window; null when we have no search data. */
  readonly meanPosition: number | null
  /** How often the article was shown over the window; null when we have no search data. */
  readonly impressions: number | null
  /** The middle article of this store, which is what "enough traffic" is measured against — never an absolute number. */
  readonly storeMedianImpressions: number | null
}

export interface RefreshEligibilityConfig {
  readonly positionMin: number
  readonly positionMax: number
  readonly cooldownDays: number
}

/**
 * The blockers that bind whoever is asking.
 *
 * The weekly scan is looking for articles worth spending a calendar day on
 * unprompted, so every rule applies. A merchant pressing "Request refresh" has
 * told us this article matters, which is a better signal about its worth than
 * a position band is — so the two rules that exist only to rank candidates
 * (where it sits, how often it is shown) do not refuse them. The three that
 * protect them from us — the cooldown, the pending repair, and their own
 * override — apply to everybody.
 */
export const MERCHANT_REQUEST_BLOCKERS: readonly RefreshBlocker[] = [
  'not_published',
  'published_via_override',
  'repair_pending',
  'within_cooldown',
]

const DAY_MS = 86400000

/** Whole days from `since` to `at`. Negative when a clock skew puts the last refresh in the future, which counts as zero elapsed. */
function daysSince(since: string, at: string): number {
  const elapsed = Date.parse(at) - Date.parse(since)
  if (!Number.isFinite(elapsed)) return 0
  return Math.max(0, Math.floor(elapsed / DAY_MS))
}

export function withinRefreshCooldown(
  lastRefreshedAt: string | null,
  at: string,
  cooldownDays: number,
): boolean {
  if (lastRefreshedAt === null) return false
  return daysSince(lastRefreshedAt, at) < cooldownDays
}

/**
 * Every reason this article cannot be rewritten right now, in a fixed order so
 * two runs of the same question produce the same list.
 *
 * All of them, not the first one found: a merchant told "it was refreshed
 * recently" who then waits sixty days only to be told about a pending repair
 * has been given the runaround by a function that stopped early.
 */
export function refreshBlockers(
  facts: RefreshCandidateFacts,
  config: RefreshEligibilityConfig,
  at: string,
): readonly RefreshBlocker[] {
  const blockers: RefreshBlocker[] = []

  if (!facts.published) blockers.push('not_published')
  if (facts.publishedViaOverride) blockers.push('published_via_override')
  if (facts.repairPending) blockers.push('repair_pending')
  if (withinRefreshCooldown(facts.lastRefreshedAt, at, config.cooldownDays)) {
    blockers.push('within_cooldown')
  }

  if (
    facts.meanPosition === null ||
    facts.meanPosition < config.positionMin ||
    facts.meanPosition > config.positionMax
  ) {
    blockers.push('position_outside_band')
  }

  if (
    facts.impressions === null ||
    facts.storeMedianImpressions === null ||
    facts.impressions < facts.storeMedianImpressions
  ) {
    blockers.push('impressions_below_store_median')
  }

  return blockers
}

/** The scan's answer: may this article be proposed for a rewrite nobody asked for? */
export function isRefreshCandidate(
  facts: RefreshCandidateFacts,
  config: RefreshEligibilityConfig,
  at: string,
): boolean {
  return refreshBlockers(facts, config, at).length === 0
}

/** The button's answer, with the reason, because the merchant is owed one. */
export function merchantRefreshBlockers(
  facts: RefreshCandidateFacts,
  config: RefreshEligibilityConfig,
  at: string,
): readonly RefreshBlocker[] {
  const all = refreshBlockers(facts, config, at)
  return MERCHANT_REQUEST_BLOCKERS.filter((blocker) => all.includes(blocker))
}

/**
 * What a rewrite is worth: the extra clicks it would win if it worked.
 *
 * The same arithmetic the opportunity engine already uses for a store page
 * that ranks — how often the page is shown, times the difference between the
 * click rate at its position now and the click rate at the position we are
 * aiming for. Imported rather than restated, so a change to how the product
 * values a position change cannot apply to store pages and miss our own
 * articles.
 *
 * It is what orders the pool: an article shown ten thousand times at position
 * six is worth far more than one shown eight hundred times at position twelve,
 * even though the second one has further to climb.
 *
 * Null when the store has no click curve or the position is unusable, which is
 * the honest answer for a store with no Search Console connection — the caller
 * decides what to do with an unrankable candidate rather than being handed a
 * zero it cannot tell apart from a genuinely worthless one.
 */
export function refreshExpectedGain(input: {
  readonly impressions: number
  readonly currentPosition: number
  readonly targetPosition: number
  readonly curve: CtrCurve
}): number | null {
  const currentCtr = expectedCtrAt(input.curve, input.currentPosition)
  const targetCtr = expectedCtrAt(input.curve, input.targetPosition)
  if (currentCtr === null || targetCtr === null) return null
  return existingPageExpectedGain({
    impressions: input.impressions,
    currentCtr,
    targetCtr,
  })
}

export interface RefreshRanking {
  readonly articleId: string
  readonly expectedGain: number
}

/**
 * The pool in the order it should be spent, best first.
 *
 * Ties break on the article's own id rather than on input order, so a retry of
 * the same replenishment plans the same calendar — the same reason the batch
 * planner sorts the way it does.
 */
export function rankRefreshCandidates(
  candidates: readonly RefreshRanking[],
): readonly RefreshRanking[] {
  return [...candidates].sort(
    (a, b) => b.expectedGain - a.expectedGain || a.articleId.localeCompare(b.articleId),
  )
}

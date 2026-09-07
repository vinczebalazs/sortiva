import type { ConflictCode } from '../../api/errors'
import type { JudgeVerdict } from '../../contracts/opportunities'
import type { FloorEvaluation } from './judge'

/**
 * "Publish anyway."
 *
 * A merchant may publish a draft we rejected — it is their site. What that
 * costs them is stated to their face before they do it, and what it costs us
 * is that the article is never allowed to teach us anything afterwards:
 *
 * - the article carries `published_via_override` for the rest of its life;
 * - it is excluded from the calibration data the quality bar is tuned on, from
 *   pattern learning, and from any headline claim about how our articles
 *   perform — an article we said was not good enough cannot be evidence that
 *   our judgement is good;
 * - its Search Console performance is still shown to the merchant, segmented,
 *   because it is their traffic.
 *
 * The confirmation the merchant sees restates the criteria that failed in
 * plain language. `overrideConfirmation` builds that list; the screen that
 * renders it is not this card's.
 */

export interface OverrideConfirmation {
  /** One line per failed criterion, in the judge's own words. */
  readonly failures: readonly { readonly criterion: string; readonly score: number; readonly justification: string }[]
}

export function overrideConfirmation(verdict: JudgeVerdict, evaluation: FloorEvaluation): OverrideConfirmation {
  return {
    failures: evaluation.failed.map((outcome) => ({
      criterion: outcome.criterion,
      score: outcome.score,
      justification: verdict.justifications[outcome.criterion] ?? '',
    })),
  }
}

/** The `gate_decisions` outcome an override writes — main §8.6 names this string. */
export const OVERRIDE_GATE_OUTCOME = 'overridden'

export interface OverrideAudit {
  readonly overriddenAt: string
  readonly failedCriteria: readonly string[]
  readonly scores: Readonly<Record<string, number>> | null
  /** Who pressed the button, so the audit row is not anonymous. */
  readonly actorUserId: string | null
}

export function overrideAudit(input: {
  readonly verdict: JudgeVerdict | null
  readonly evaluation: FloorEvaluation | null
  readonly actorUserId: string | null
  readonly now: Date
}): OverrideAudit {
  return {
    overriddenAt: input.now.toISOString(),
    failedCriteria: input.evaluation?.failed.map((o) => o.criterion) ?? [],
    scores: input.verdict?.scores ?? null,
    actorUserId: input.actorUserId,
  }
}

/**
 * Overriding a decision that was never made.
 *
 * Only a draft the quality bar actually turned down can be published anyway.
 * Anything else is refused, and the two refusals are told apart because they
 * mean different things to the merchant: an article that has already gone out
 * needs nothing doing, while one that was never held back is a button they
 * should not have been shown.
 */
export const OVERRIDE_NOT_REJECTED_CODE: ConflictCode = 'article_not_rejected'

export const OVERRIDE_ALREADY_PUBLISHED_CODE: ConflictCode = 'article_already_published'

export function overrideConflictFor(actualState: string): ConflictCode {
  return actualState === 'published' ? OVERRIDE_ALREADY_PUBLISHED_CODE : OVERRIDE_NOT_REJECTED_CODE
}

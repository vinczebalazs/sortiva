import type { ClaimPlan, PlannedClaim } from '../../generation/claims'
import type { Draft } from '../../generation/draft'
import { checkableKindsIn } from './checkable'
import { sentencesOf } from './prose'

/**
 * How strongly a sentence is allowed to be phrased, given what stands behind
 * it.
 *
 * Strong evidence permits a flat assertion. Middling evidence permits only
 * hedged or scoped phrasing. Weak evidence permits nothing — the claim should
 * have been dropped and logged as a gap instead of softened into something
 * vague.
 *
 * One rule is checked here, and it is the one both halves of the comparison
 * are in our own data for: **a numeric threshold, duration or rate may not
 * rest on a low-confidence claim.** "Above 300 kg" is either supported or it
 * is not; there is no hedged version of a number. The sentence's figures are
 * found by shape, so this holds whatever language the store publishes in.
 *
 * The companion rule — absolute language ("always", "never", "the only", and
 * whatever a language's equivalents are) permitted only on a high-confidence
 * claim and never on a recommendation — is **asked for in the writing prompt
 * and no longer checked here.** Recognising it needed a list of words in one
 * language, which held an English store to a bar a Danish store was never
 * held to. Removing the list is what makes the two equal, and the cost, chosen
 * knowingly, is that nothing deterministic stands behind that rule any more.
 * See DECISIONS 2026-09-04.
 */

export type StrengthIssueKind = 'threshold_on_weak_claim'

export interface StrengthIssue {
  readonly kind: StrengthIssueKind
  readonly location: string
  readonly sentence: string
  readonly detail: string
}

export interface StrengthCheckResult {
  readonly passed: boolean
  readonly issues: readonly StrengthIssue[]
}

const QUANTIFIED = new Set(['measurement', 'percentage', 'duration'])

export function checkAssertionStrength(draft: Draft, plan: ClaimPlan): StrengthCheckResult {
  const byId = new Map(plan.claims.map((c) => [c.id, c]))
  const issues: StrengthIssue[] = []

  for (const sentence of sentencesOf(draft)) {
    const cited: PlannedClaim[] = sentence.citedClaimIds
      .map((id) => byId.get(id))
      .filter((c): c is PlannedClaim => c !== undefined)
    if (cited.length === 0) continue

    const kinds = checkableKindsIn(sentence.plain)
    if (kinds.some((kind) => QUANTIFIED.has(kind)) && cited.every((c) => c.confidence === 'low')) {
      issues.push({
        location: sentence.block.label,
        sentence: sentence.plain,
        kind: 'threshold_on_weak_claim',
        detail: `a figure this specific cannot rest on a low-confidence claim (${cited.map((c) => c.id).join(', ')})`,
      })
    }
  }

  return { passed: issues.length === 0, issues }
}

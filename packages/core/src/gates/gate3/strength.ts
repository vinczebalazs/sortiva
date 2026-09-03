import type { ClaimPlan, PlannedClaim } from '../../generation/claims'
import type { Draft } from '../../generation/draft'
import { absolutesIn, checkableKindsIn, type CheckableLexicon } from './checkable'
import { sentencesOf } from './prose'

/**
 * How strongly a sentence is allowed to be phrased, given what stands behind
 * it.
 *
 * Strong evidence permits a flat assertion. Middling evidence permits only
 * hedged or scoped phrasing. Weak evidence permits nothing — the claim should
 * have been dropped and logged as a gap instead of softened into something
 * vague. Both halves of that comparison are represented in our own data (the
 * sentence's wording, the cited claim's confidence band), which is why this is
 * a free check rather than a judgement.
 *
 * Two rules, from `docs/content-pointers.md` §3:
 *
 * - **Absolute language** — *always, never, must, cannot, every, all, the
 *   best, the most, the only, guarantees, eliminates, prevents, ensures* — is
 *   permitted only on a high-confidence claim, and **never on a
 *   recommendation** at all. Advice is a judgement about fit; a judgement
 *   stated as a law is the sentence that gets a merchant into trouble.
 * - **A numeric threshold, duration or rate** may not rest on a low-confidence
 *   claim. "Above 300 kg" is either supported or it is not; there is no hedged
 *   version of a number.
 */

export type StrengthIssueKind =
  | 'absolute_on_weak_claim'
  | 'absolute_on_recommendation'
  | 'threshold_on_weak_claim'

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

export function checkAssertionStrength(
  draft: Draft,
  plan: ClaimPlan,
  lexicon: CheckableLexicon | null,
): StrengthCheckResult {
  const byId = new Map(plan.claims.map((c) => [c.id, c]))
  const issues: StrengthIssue[] = []

  for (const sentence of sentencesOf(draft)) {
    const cited: PlannedClaim[] = sentence.citedClaimIds
      .map((id) => byId.get(id))
      .filter((c): c is PlannedClaim => c !== undefined)
    if (cited.length === 0) continue

    const base = { location: sentence.block.label, sentence: sentence.plain }
    const absolutes = absolutesIn(sentence.plain, lexicon)

    if (absolutes.length > 0) {
      const recommendation = cited.find((c) => c.kind === 'recommendation')
      if (recommendation) {
        issues.push({
          ...base,
          kind: 'absolute_on_recommendation',
          detail: `"${absolutes.join('", "')}" states advice as a law — claim ${recommendation.id} is a recommendation, not a fact`,
        })
      } else if (!cited.some((c) => c.confidence === 'high')) {
        issues.push({
          ...base,
          kind: 'absolute_on_weak_claim',
          detail: `"${absolutes.join('", "')}" needs a strongly-supported claim behind it; ${cited
            .map((c) => `${c.id} is ${c.confidence}`)
            .join(', ')}`,
        })
      }
    }

    const kinds = checkableKindsIn(sentence.plain, lexicon)
    if (kinds.some((kind) => QUANTIFIED.has(kind)) && cited.every((c) => c.confidence === 'low')) {
      issues.push({
        ...base,
        kind: 'threshold_on_weak_claim',
        detail: `a figure this specific cannot rest on a low-confidence claim (${cited.map((c) => c.id).join(', ')})`,
      })
    }
  }

  return { passed: issues.length === 0, issues }
}

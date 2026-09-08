import type { GatesConfig } from '@sortiva/rules'
import type { JudgeLite, JudgeVerdict } from '../contracts/opportunities'
import { citableStoreFacts, type OptimizeEvidencePack } from './pack'
import type { OptimizeRecommendation } from './recommendation'

/**
 * The grading half of the OPTIMIZE path — main §10.3 step 5.
 *
 * Two criteria, not the article judge's six. Information gain is deliberately
 * not among them: the page already ranks, and a recommendation is additive to
 * it, so "is this new to the world" is the wrong question. What is left is the
 * two that decide whether the merchant can safely paste it in — is every
 * statement traceable, and does it address what the searcher wanted.
 *
 * Both are held at the same floor, and the pass is on the **minimum**: a
 * beautifully targeted recommendation that asserts something the store never
 * recorded fails, and so does an impeccably grounded one that answers a
 * different question.
 */

export const OPTIMIZE_JUDGE_CRITERIA = ['factualGrounding', 'searchIntentMatch'] as const

export type OptimizeJudgeCriterion = (typeof OPTIMIZE_JUDGE_CRITERIA)[number]

export interface OptimizeCriterionOutcome {
  readonly criterion: OptimizeJudgeCriterion
  readonly score: number
  readonly floor: number
  readonly passed: boolean
}

export interface OptimizeGradeResult {
  readonly passed: boolean
  readonly outcomes: readonly OptimizeCriterionOutcome[]
  readonly failed: readonly OptimizeCriterionOutcome[]
  readonly verdict: JudgeVerdict
}

function floorFor(
  criterion: OptimizeJudgeCriterion,
  config: GatesConfig['optimize_recommendation'],
): number {
  return criterion === 'factualGrounding' ? config.grounding_min : config.intent_match_min
}

/**
 * The verdict's own `passed` is not read here.
 *
 * `JudgeLite` computes it against the article floors, where anything other
 * than information gain and grounding passes at 3 — and intent match is one of
 * those "anything other". These recommendations are held to 4 on both, so the
 * decision is made here against this card's own numbers.
 */
export function evaluateOptimizeFloors(
  verdict: JudgeVerdict,
  config: GatesConfig['optimize_recommendation'],
): OptimizeGradeResult {
  const scores = verdict.scores as Readonly<Record<string, number | undefined>>
  const outcomes = OPTIMIZE_JUDGE_CRITERIA.map((criterion) => {
    const score = scores[criterion] ?? 0
    const floor = floorFor(criterion, config)
    return { criterion, score, floor, passed: score >= floor }
  })
  const failed = outcomes.filter((outcome) => !outcome.passed)
  return { passed: failed.length === 0, outcomes, failed, verdict }
}

/**
 * What the grader is shown: the suggestions, and the evidence they were made
 * from.
 *
 * Two rules pull in opposite directions here and both have to hold.
 *
 * **Never more than the writer had.** Grounding asks whether every statement is
 * traceable to the evidence, so a grader holding a fact the writer never saw can
 * confirm a sentence the model invented — the price range is the one that bites,
 * because a fabricated "from £120" reads as verified against a figure that was
 * never in the writing prompt. The store's facts therefore come from
 * `citableStoreFacts`, the same call that renders them into the writer's prompt,
 * rather than from a second walk over the pack. `evidence-parity.test.ts`
 * fails if the two ever diverge again.
 *
 * **Less than the writer had, on purpose.** The page's body text, the search
 * numbers, the store's voice, the link candidates and the writing call's own
 * conversation are all left out. Withholding costs nothing — a grader cannot
 * wrongly confirm a claim on evidence it does not hold — and it is what keeps
 * the grading a separate judgement rather than a re-run of the writer's.
 */
export function gradingEvidence(pack: OptimizeEvidencePack): Record<string, unknown> {
  return {
    search: pack.targetQuery,
    page: {
      url: pack.page.url,
      type: pack.page.pageType,
      title: pack.page.title,
      seoTitle: pack.page.seoTitle,
      seoDescription: pack.page.seoDescription,
      headings: pack.page.headings,
    },
    coveredByRankingPagesAndNotOurs: pack.missingSubtopics.map((subtopic) => ({
      subtopic: subtopic.name,
      onPages: subtopic.competitors.map((citation) => citation.url),
    })),
    storeFacts: citableStoreFacts(pack).map((fact) => ({
      address: fact.address,
      fact: fact.label,
      value: fact.value,
    })),
  }
}

export async function gradeRecommendation(
  judge: JudgeLite,
  recommendation: OptimizeRecommendation,
  pack: OptimizeEvidencePack,
  config: GatesConfig['optimize_recommendation'],
): Promise<OptimizeGradeResult> {
  const verdict = await judge.grade(recommendation, gradingEvidence(pack))
  return evaluateOptimizeFloors(verdict, config)
}

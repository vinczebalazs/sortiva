import type { GatesConfig } from '@sortiva/rules'
import type { JudgeLite, JudgeVerdict } from '../contracts/opportunities'
import type { OptimizeEvidencePack } from './pack'
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
 * from. Not the pack object itself — the page's whole body and every fact
 * sheet would bury the two questions being asked — and never the writing
 * call's own conversation, so the grader cannot grade the reasoning instead of
 * the result.
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
    storeFacts: pack.products.map((product) => ({ product: product.title, facts: product.factSheet })),
    families: pack.families.map((family) => ({
      name: family.name,
      differsBy: family.differentiationAxes,
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

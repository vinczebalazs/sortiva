import type { GatesConfig } from '@sortiva/rules'
import { accountAttribution } from '../../contracts/analytics'
import type { LlmClient, LlmRequest } from '../../contracts/llm'
import type { JudgeVerdict } from '../../contracts/opportunities'
import type { Draft } from '../../generation/draft'
import type { EvidencePack } from '../../generation/evidence-pack'
import { renderDraftMarkdown } from './prose'

/**
 * The judge — a separate call that grades the finished article.
 *
 * Two properties make it a check on anything rather than a rubber stamp, and
 * both are structural rather than a matter of prompting:
 *
 * **It is blind.** Everything it sees is built here from the draft, the
 * evidence pack and the three pages currently ranking. There is no parameter
 * on this request through which the writer's conversation — its system prompt,
 * its instructions, its approved claim list, its earlier attempt — could
 * reach it, because a grader shown the writer's reasoning grades the reasoning
 * and not the article. `judge.test.ts` proves the built request carries none
 * of it.
 *
 * **It is never the cheaper model.** The request names no model, so the call
 * runs on whatever tier `judge` is configured for, which is the same tier the
 * writer runs on. A grader that thinks less hard than the writer would pass
 * whatever the writer could talk it into.
 */

/**
 * The five criteria of main §8.4 plus **ecommerce usefulness** — is the
 * decision the reader has to make identifiable, are the trade-offs stated, is
 * the next step obvious, and has the article quietly become a sales pitch.
 * That last one is distinct from being accurate and from being new, and it is
 * the question a shopper actually has.
 */
export const JUDGE_CRITERIA = [
  'informationGain',
  'factualGrounding',
  'searchIntentMatch',
  'actionability',
  'languageQuality',
  'ecommerceUsefulness',
] as const

export type JudgeCriterion = (typeof JUDGE_CRITERIA)[number]

export interface JudgePrompt {
  readonly version: string
  readonly text: string
}

export interface JudgeInput {
  readonly prompt: JudgePrompt
  readonly accountId: string
  readonly targetKeyword: string
  readonly draft: Draft
  readonly pack: EvidencePack
}

function scoreSchema() {
  const properties: Record<string, unknown> = {}
  for (const criterion of JUDGE_CRITERIA) {
    properties[criterion] = { type: 'integer', minimum: 1, maximum: 5 }
  }
  return { type: 'object', additionalProperties: false, required: [...JUDGE_CRITERIA], properties }
}

function justificationSchema() {
  const properties: Record<string, unknown> = {}
  for (const criterion of JUDGE_CRITERIA) {
    properties[criterion] = { type: 'string', minLength: 1 }
  }
  return { type: 'object', additionalProperties: false, required: [...JUDGE_CRITERIA], properties }
}

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scores', 'justifications'],
  properties: { scores: scoreSchema(), justifications: justificationSchema() },
} as const

/** The pack as facts, not as the writer's brief: what the article says has to be traceable to this. */
function packBlock(pack: EvidencePack): string {
  const products = pack.products.map((product) => {
    const facts = Object.entries(product.factSheet)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([field, value]) => `${field}: ${Array.isArray(value) ? value.join('; ') : String(value)}`)
    return `- ${product.title} — ${facts.join(' | ') || '(no recorded facts)'}`
  })
  const families = pack.families.map((f) => `- ${f.name}: ${f.differentiationAxes.join(', ') || '(no axes)'}`)
  return ['Store facts available:', ...products, '', 'Product families and how they differ:', ...families].join('\n')
}

/** The three ranking pages, so "is there anything new here" is answered against the SERP rather than in the abstract. */
function topThreeBlock(pack: EvidencePack): string {
  const top = [...pack.serp.competitorAngles].sort((a, b) => a.position - b.position).slice(0, 3)
  if (top.length === 0) return 'Pages currently ranking: none could be read.'
  return [
    'Pages currently ranking for this query:',
    ...top.map((angle) => `- #${angle.position} ${angle.domain}\n  Covers: ${angle.headings.join(' / ')}\n  Excerpt: ${angle.excerpt}`),
  ].join('\n')
}

export function buildJudgeRequest(input: JudgeInput): LlmRequest {
  return {
    callType: 'judge',
    promptVersion: input.prompt.version,
    system: input.prompt.text,
    messages: [
      {
        role: 'user',
        content: [
          `Target search query: ${input.targetKeyword}`,
          '',
          '--- The article ---',
          renderDraftMarkdown(input.draft),
          '',
          '--- What the store actually knows ---',
          packBlock(input.pack),
          '',
          '--- What already ranks ---',
          topThreeBlock(input.pack),
        ].join('\n'),
      },
    ],
    maxTokens: 2000,
    schema: RESPONSE_SCHEMA,
    attribution: accountAttribution(input.accountId),
    // No `model` — see the note at the top of this file. Overriding it here
    // would be how the judge quietly becomes the cheap model.
  }
}

export interface CriterionOutcome {
  readonly criterion: string
  readonly score: number
  readonly floor: number
  readonly passed: boolean
}

export interface FloorEvaluation {
  readonly passed: boolean
  readonly outcomes: readonly CriterionOutcome[]
  readonly failed: readonly CriterionOutcome[]
  /** True when information gain is among the failures — the one that ends the run outright. */
  readonly informationGainFailed: boolean
}

/**
 * Gate on the minimum, never the average. Information gain and grounding are
 * held one point higher than everything else, so a draft that is beautifully
 * written about nothing cannot be carried across by its other scores.
 */
export function evaluateFloors(
  scores: Readonly<Record<string, number>>,
  config: GatesConfig['draft_grading'],
): FloorEvaluation {
  const outcomes: CriterionOutcome[] = Object.entries(scores).map(([criterion, score]) => {
    const floor =
      criterion === 'informationGain'
        ? config.information_gain_min
        : criterion === 'factualGrounding'
          ? config.factual_grounding_min
          : config.other_criteria_min
    return { criterion, score, floor, passed: score >= floor }
  })

  const failed = outcomes.filter((o) => !o.passed)
  return {
    passed: failed.length === 0,
    outcomes,
    failed,
    informationGainFailed: failed.some((o) => o.criterion === 'informationGain'),
  }
}

export interface GradeDraftResult {
  readonly verdict: JudgeVerdict
  readonly evaluation: FloorEvaluation
}

export interface JudgeDeps {
  readonly llm: LlmClient
}

export async function gradeDraft(
  deps: JudgeDeps,
  input: JudgeInput,
  config: GatesConfig['draft_grading'],
): Promise<GradeDraftResult> {
  const result = await deps.llm.complete<{
    scores: Record<JudgeCriterion, number>
    justifications: Record<JudgeCriterion, string>
  }>(buildJudgeRequest(input))

  const evaluation = evaluateFloors(result.output.scores, config)
  return {
    verdict: {
      passed: evaluation.passed,
      scores: result.output.scores,
      justifications: result.output.justifications,
      promptVersion: result.promptVersion,
      modelId: result.modelId,
    },
    evaluation,
  }
}

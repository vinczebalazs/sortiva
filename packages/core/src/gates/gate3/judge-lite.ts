import type { GatesConfig } from '@sortiva/rules'
import { accountAttribution } from '../../contracts/analytics'
import type { LlmClient } from '../../contracts/llm'
import type { JudgeLite, JudgeVerdict } from '../../contracts/opportunities'
import { evaluateFloors, type JudgePrompt } from './judge'

/**
 * The real `JudgeLite`, replacing the stub that passed everything.
 *
 * The seam exists because Lane E's OPTIMIZE recommendations need grading too
 * (build plan §4), and they are not articles: a recommendation is a short
 * structured artefact with its own criteria. So the class is given its prompt
 * and its criteria rather than hard-coding the article judge's, and everything
 * that must be true of *any* grader we run is enforced here regardless of
 * which artefact it is looking at:
 *
 * - it is a separate call, built from the artefact and its evidence only;
 * - it names no model, so it can never be quietly run on the cheap tier;
 * - it gates on the minimum score against the floors in `packages/rules`,
 *   never on an average.
 *
 * The article pipeline does not go through this interface — it calls
 * `gradeDraft` directly, because it has a draft and an evidence pack rather
 * than the two opaque values this seam was frozen with.
 */
export class LlmJudgeLite implements JudgeLite {
  constructor(
    private readonly deps: {
      readonly llm: LlmClient
      readonly prompt: JudgePrompt
      readonly criteria: readonly string[]
      readonly config: GatesConfig['draft_grading']
      /** Attribution needs an account; the caller names the one whose work is being graded. */
      readonly accountId: string
    },
  ) {}

  async grade(recommendation: unknown, pack: unknown): Promise<JudgeVerdict> {
    const properties: Record<string, unknown> = {}
    const justifications: Record<string, unknown> = {}
    for (const criterion of this.deps.criteria) {
      properties[criterion] = {
        type: 'integer',
        minimum: this.deps.config.criterion_score_min,
        maximum: this.deps.config.criterion_score_max,
      }
      justifications[criterion] = { type: 'string', minLength: 1 }
    }

    const result = await this.deps.llm.complete<{
      scores: Record<string, number>
      justifications: Record<string, string>
    }>({
      callType: 'judge',
      promptVersion: this.deps.prompt.version,
      system: this.deps.prompt.text,
      messages: [
        {
          role: 'user',
          content: [
            '--- What to grade ---',
            JSON.stringify(recommendation, null, 2),
            '',
            '--- The evidence behind it ---',
            JSON.stringify(pack, null, 2),
          ].join('\n'),
        },
      ],
      maxTokens: 2000,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['scores', 'justifications'],
        properties: {
          scores: { type: 'object', additionalProperties: false, required: [...this.deps.criteria], properties },
          justifications: {
            type: 'object',
            additionalProperties: false,
            required: [...this.deps.criteria],
            properties: justifications,
          },
        },
      },
      attribution: accountAttribution(this.deps.accountId),
    })

    const evaluation = evaluateFloors(result.output.scores, this.deps.config)
    return {
      passed: evaluation.passed,
      scores: result.output.scores as JudgeVerdict['scores'],
      justifications: result.output.justifications,
      promptVersion: result.promptVersion,
      modelId: result.modelId,
    }
  }
}

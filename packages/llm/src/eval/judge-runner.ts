import {
  buildJudgeRequest,
  evaluateFloors,
  UnrecordedSpend,
  type Draft,
  type EvidencePack,
  type LlmClient,
  type PosthogCapture,
} from '@sortiva/core'
import { rules } from '@sortiva/rules'
import { AnthropicLlmClient } from '../client'
import { loadPrompt } from '../prompts'
import type { EvalRunner } from './runner'

/**
 * What `judge.eval` runs: one draft, its evidence pack and the pages ranking
 * against it go in; the judge's per-criterion scores come out, graded against
 * human gold scores.
 *
 * Two failures are scored separately, because one can hide inside an average
 * and the other cannot. Per-criterion mean absolute error says whether the
 * judge agrees with human graders at all; a **false pass** — a draft humans
 * failed that the judge lets through — fails the set outright whatever the
 * error looks like. That asymmetry is the quality stance made measurable: the
 * acceptable error is a false reject, never a false pass.
 *
 * The runner returns `passed` alongside the scores, computed from the same
 * floors in `packages/rules` the live gate uses, so the false-pass check is
 * asking about the decision that would really have been made rather than about
 * a number.
 */

export interface JudgeEvalInput {
  readonly targetKeyword: string
  readonly draft: Draft
  readonly pack: EvidencePack
  /** Free-text note on what the case is testing. Not read by the runner. */
  readonly note?: string
}

/** The eval has no analytics project and no database; the spend it makes is the CI job's own bill. */
const UNRECORDED_CAPTURE: Pick<PosthogCapture, 'captureAiGeneration'> = {
  captureAiGeneration() {},
}

/**
 * The real client, deliberately — and on the judge's own tier.
 *
 * An eval that grades a stand-in grades nothing: the whole question is what
 * *this model* does with *this prompt*, so with no key the set fails loudly and
 * names what is missing rather than scoring a substitute and reporting a pass.
 */
function anthropicClient(): LlmClient {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'judge.eval needs ANTHROPIC_API_KEY: it grades what the real model does with the real judging prompt, ' +
        'and a stand-in would report a pass that means nothing.',
    )
  }
  return new AnthropicLlmClient({ capture: UNRECORDED_CAPTURE, ledger: new UnrecordedSpend() })
}

/**
 * `client` is injectable so the set's own wiring — the prompt, the schema, the
 * floors and the scoring — can be proved in the ordinary test run, where
 * calling a vendor is not an option. `pnpm eval` passes nothing and gets the
 * real model.
 */
export function judgeEvalRunner(client?: LlmClient): EvalRunner {
  return async (input, config) => {
    const testCase = input as JudgeEvalInput
    const llm = client ?? anthropicClient()
    const version = Number((config.promptVersion ?? 'judge.v1').split('.v')[1] ?? 1)
    const prompt = loadPrompt('judge', version)

    const result = await llm.complete<{ scores: Record<string, number>; justifications: Record<string, string> }>(
      buildJudgeRequest({
        prompt: { version: prompt.version, text: prompt.text },
        // The eval has no account behind it. Attribution is required on every
        // call, so the set names itself rather than borrowing a real store's id.
        accountId: 'judge-eval',
        targetKeyword: testCase.targetKeyword,
        draft: testCase.draft,
        pack: testCase.pack,
      }),
    )

    const evaluation = evaluateFloors(result.output.scores, rules().defaults.gates.draft_grading)
    return { ...result.output.scores, passed: evaluation.passed }
  }
}

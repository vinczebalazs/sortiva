import {
  buildDistillLlmRequest,
  descriptionText,
  EXTRACTED_FIELDS,
  UnrecordedSpend,
  type ExtractedFacts,
  type LlmClient,
  type PosthogCapture,
} from '@sortiva/core'
import { AnthropicLlmClient } from '../client'
import { loadPrompt } from '../prompts'
import type { EvalRunner } from './runner'

/**
 * What `distillation.eval` runs: one real product description in, one fact
 * sheet out, graded against a hand-written expected sheet.
 *
 * The set is the only thing standing between a prompt edit and a catalogue of
 * fabricated product attributes. It grades two different failures separately,
 * because one of them can hide inside an average and the other cannot:
 * field-level F1 across the set says how much the extraction finds and gets
 * right, while **any** field value the gold sheet does not contain fails that
 * case outright, whatever the aggregate says. A model that invents a material
 * has not scored badly, it has produced a lie with a product page behind it.
 *
 * Only the ten extracted fields are graded. The merged price and variant axes
 * are not model output at all, and `fact_count` and `fluff_discarded` are
 * excluded deliberately: the count is computed from the sheet rather than
 * taken from the model, and a boolean disagreement about whether marketing
 * language was present would register as a *fabricated fact* and hard-fail a
 * case over something that is not a claim about the product.
 */

/** One case's input: a real product as the store published it. */
export interface DistillEvalInput {
  readonly title: string
  /** As Shopify stores it, markup and all — so the case exercises the same funnel production uses. */
  readonly bodyHtml: string
  /** Free-text note on what the case is testing. Not read by the runner. */
  readonly note?: string
}

/** The eval has no analytics project and no database; the spend it makes is the CI job's own bill. */
const UNRECORDED_CAPTURE: Pick<PosthogCapture, 'captureAiGeneration'> = {
  captureAiGeneration() {},
}

/**
 * The real client, deliberately.
 *
 * An eval that grades a stand-in grades nothing: the whole question is what
 * *this model* does with *this prompt*, so with no key the set fails loudly and
 * names what is missing rather than scoring a substitute and reporting a pass.
 */
function anthropicClient(): LlmClient {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'distillation.eval needs ANTHROPIC_API_KEY: it grades what the real model does with the real prompt, ' +
        'and a stand-in would report a pass that means nothing.',
    )
  }
  return new AnthropicLlmClient({ capture: UNRECORDED_CAPTURE, ledger: new UnrecordedSpend() })
}

/**
 * `client` is injectable so the set's own wiring — the prompt, the schema, the
 * scoring and the thresholds — can be proved in the ordinary test run, where
 * calling a vendor is not an option. `pnpm eval` passes nothing and gets the
 * real model.
 */
export function distillEvalRunner(client?: LlmClient): EvalRunner {
  return async (input) => {
    const testCase = input as DistillEvalInput
    const llm = client ?? anthropicClient()
    const prompt = loadPrompt('distill', 1)

    const result = await llm.complete<ExtractedFacts>(
      buildDistillLlmRequest({
        prompt: { version: prompt.version, text: prompt.text },
        // The eval has no account behind it. Attribution is required on every
        // call, so the set names itself rather than borrowing a real store's id.
        accountId: 'distillation-eval',
        title: testCase.title,
        descriptionText: descriptionText(testCase.bodyHtml),
      }),
    )

    return gradedFields(result.output)
  }
}

/** The ten extracted fields, and nothing else, in a shape the F1 scorer reads. */
export function gradedFields(facts: ExtractedFacts): Record<string, unknown> {
  const graded: Record<string, unknown> = {}
  for (const field of EXTRACTED_FIELDS) graded[field] = facts[field]
  return graded
}

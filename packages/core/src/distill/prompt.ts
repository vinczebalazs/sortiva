import { accountAttribution } from '../contracts/analytics'
import type { LlmRequest } from '../contracts/llm'
import { DISTILL_MAX_OUTPUT_TOKENS, DISTILL_TEMPERATURE } from './limits'
import { DISTILL_SCHEMA } from './schema'

/**
 * The versioned prompt text, from `prompts/<name>.v<N>.md`. Supplied by the
 * caller because `packages/llm` owns the loader and `packages/core` cannot
 * depend on it without a cycle.
 */
export interface DistillPrompt {
  /** e.g. `distill.v1`; stamped on the fact sheet and on every spend record. */
  readonly version: string
  readonly text: string
}

/**
 * One model call: the facts a product's own words support, and nothing else.
 *
 * Three things this function makes non-optional:
 *
 * - `callType: 'distill'`, which binds the call to the cheap tier. This is one
 *   call per product across a whole catalogue, so the tier is most of what the
 *   step costs.
 * - The JSON Schema, on every call. The answer is a structured artefact other
 *   steps read by field name, so a completion that does not fit is retried once
 *   and then fails — we never keep the half that parsed.
 * - The prompt carries exactly two things: the title and the description text.
 *   Price, stock and the store's identity are not in it, so a call cannot be
 *   made different — and re-billed — by a weekend sale.
 */
export function buildDistillLlmRequest(input: {
  prompt: DistillPrompt
  accountId: string
  /** The store's claimed domain, so spend joins to the account it belongs to. */
  domain?: string
  title: string
  descriptionText: string
}): LlmRequest {
  return {
    callType: 'distill',
    promptVersion: input.prompt.version,
    system: input.prompt.text,
    messages: [
      {
        role: 'user',
        content: `Product title: ${input.title}\n\nProduct description:\n${input.descriptionText}`,
      },
    ],
    maxTokens: DISTILL_MAX_OUTPUT_TOKENS,
    temperature: DISTILL_TEMPERATURE,
    schema: DISTILL_SCHEMA,
    attribution:
      input.domain === undefined
        ? accountAttribution(input.accountId)
        : accountAttribution(input.accountId, input.domain),
  }
}

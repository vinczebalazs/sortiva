import { accountAttribution } from '../contracts/analytics'
import type { LlmRequest } from '../contracts/llm'
import { renderPersonaBrief, type PersonaBriefInput } from './brief'
import { PERSONA_MAX_OUTPUT_TOKENS } from './limits'
import { PERSONA_SCHEMA } from './schema'

/**
 * The versioned prompt text, from `prompts/<name>.v<N>.md`. Supplied by the
 * caller because `packages/llm` owns the loader and `packages/core` cannot
 * depend on it without a cycle.
 */
export interface PersonaPrompt {
  /** e.g. `persona.v1`; stamped on the stored profile and on every spend record. */
  readonly version: string
  readonly text: string
}

/**
 * One model call: who this store is, from what its catalogue and its own pages
 * say about it.
 *
 * Three things this function makes non-optional:
 *
 * - `callType: 'persona'`, which binds the call to the stronger tier. This is
 *   one call per store and the judgement everything downstream inherits, so it
 *   is the one place in onboarding where paying for a better model is obviously
 *   worth it. No model is named here: substituting a cheaper one for a busy
 *   hour is exactly the quiet quality loss the product refuses to make.
 * - The JSON Schema, on every call. The answer is read field by field by the
 *   confirmation screen, the search-data lookups and every article template.
 * - The brief, which carries families rather than products and has no field a
 *   product description could travel in.
 */
export function buildPersonaLlmRequest(input: {
  prompt: PersonaPrompt
  accountId: string
  /** The store's claimed domain, so spend joins to the account it belongs to. */
  domain?: string
  brief: PersonaBriefInput
}): LlmRequest {
  return {
    callType: 'persona',
    promptVersion: input.prompt.version,
    system: input.prompt.text,
    messages: [{ role: 'user', content: renderPersonaBrief(input.brief) }],
    maxTokens: PERSONA_MAX_OUTPUT_TOKENS,
    schema: PERSONA_SCHEMA,
    attribution:
      input.domain === undefined
        ? accountAttribution(input.accountId)
        : accountAttribution(input.accountId, input.domain),
  }
}

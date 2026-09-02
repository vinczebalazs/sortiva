import { accountAttribution } from '../contracts/analytics'
import type { LlmRequest } from '../contracts/llm'
import { renderSeedBrief, type SeedBriefInput } from './brief'
import { SEED_KEYWORDS_MAX_OUTPUT_TOKENS, SEED_KEYWORDS_SCHEMA } from './schema'

/**
 * The versioned prompt text, from `prompts/<name>.v<N>.md`, already rendered
 * with the candidate range. Supplied by the caller because `packages/llm` owns
 * the loader and `packages/core` cannot depend on it without a cycle.
 */
export interface SeedKeywordsPrompt {
  /** e.g. `seeds.v1`; stamped on every spend record and on the analytics event. */
  readonly version: string
  readonly text: string
}

/**
 * One model call: what would this shop's customers type into Google.
 *
 * `callType: 'seeds'` binds it to the stronger tier and no model is named here.
 * The terms this call produces decide which searches we buy data for, which
 * competitors we find, and ultimately what gets written — a cheaper model
 * proposing blander terms would not fail anywhere visible, it would just make
 * the store's whole search strategy generic.
 *
 * The call goes through the instrumented wrapper, so it is cached on its
 * rendered prompt before the answer is processed: a step killed between the
 * model answering and the terms being written replays the stored completion
 * rather than paying again, and gets the same terms rather than a second
 * opinion.
 */
export function buildSeedKeywordsLlmRequest(input: {
  prompt: SeedKeywordsPrompt
  accountId: string
  /** The store's claimed domain, so spend joins to the account it belongs to. */
  domain?: string
  brief: SeedBriefInput
}): LlmRequest {
  return {
    callType: 'seeds',
    promptVersion: input.prompt.version,
    system: input.prompt.text,
    messages: [{ role: 'user', content: renderSeedBrief(input.brief) }],
    maxTokens: SEED_KEYWORDS_MAX_OUTPUT_TOKENS,
    schema: SEED_KEYWORDS_SCHEMA,
    attribution:
      input.domain === undefined
        ? accountAttribution(input.accountId)
        : accountAttribution(input.accountId, input.domain),
  }
}

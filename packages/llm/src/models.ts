/**
 * Which model each kind of call runs on, by explicit id — never a moving
 * "latest" alias, because an artefact stamped with an alias cannot be
 * reproduced once the alias moves.
 *
 * The cheaper tier does product distillation and the preview card; the stronger
 * one does the persona, seed keywords, drafting and the draft judge. The judge
 * is **never** downgraded: a grader that thinks less hard than the writer is
 * not a check on anything.
 *
 * Prices are per million tokens, used to cost cache replays at zero and to let
 * the test doubles account for spend without a network call.
 */

export interface ModelSpec {
  readonly id: string
  readonly inputUsdPerMTok: number
  readonly outputUsdPerMTok: number
  /**
   * The current Sonnet generation rejects `temperature`/`top_p` with a 400, so
   * the wrapper must not forward one. The preview call wants a low temperature
   * and runs on Haiku, where it is accepted.
   */
  readonly supportsTemperature: boolean
}

export const MODELS = {
  sonnet: {
    id: 'claude-sonnet-5',
    inputUsdPerMTok: 2,
    outputUsdPerMTok: 10,
    supportsTemperature: false,
  },
  haiku: {
    id: 'claude-haiku-4-5',
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 5,
    supportsTemperature: true,
  },
} as const satisfies Record<string, ModelSpec>

export type ModelTier = keyof typeof MODELS

/** Which tier each call type runs on. */
export const CALL_TYPE_TIER = {
  distill: 'haiku',
  preview: 'haiku',
  persona: 'sonnet',
  seeds: 'sonnet',
  judge: 'sonnet',
  intent_gap: 'sonnet',
  optimize_reco: 'sonnet',
  // A classification over a short title and a list of the account's own
  // family names — the same shape of task as `distill` (structured
  // extraction, not open-ended reasoning or writing), and on the request path
  // of a merchant waiting for the "Add" button to resolve. See DECISIONS
  // 2026-09-03 T4.2.
  topic_classify: 'haiku',
  // The claim plan decides what the article is allowed to assert and how
  // strongly — real judgement over evidence, not a short classification, so
  // it runs on the same tier as the writer it gates. T4.3, DECISIONS
  // 2026-09-03 T4.3.
  claim_plan: 'sonnet',
  // "Sonnet draft via LlmClient (call_type: draft)" — the build plan's own
  // words for this card. T4.3.
  draft: 'sonnet',
} as const satisfies Record<string, ModelTier>

/**
 * Env overrides exist so a model can be pinned per environment without a code
 * change, but they must still name an id explicitly — an alias is rejected, so
 * "latest" cannot slip in through configuration either.
 *
 * One call type does not come through here at all — see
 * `resolveModelForCallType` below.
 */
const ALIAS_PATTERN = /(^|-)(latest|preview)$/

export function resolveModel(
  tier: ModelTier,
  env: NodeJS.ProcessEnv = process.env,
): ModelSpec {
  const spec = MODELS[tier]
  const override = env[`ANTHROPIC_MODEL_${tier.toUpperCase()}`]
  if (!override) return spec
  if (ALIAS_PATTERN.test(override)) {
    throw new Error(
      `ANTHROPIC_MODEL_${tier.toUpperCase()}="${override}" looks like an alias. Model ids must be explicit, or an artefact stamped with one cannot be reproduced later.`,
    )
  }
  return { ...spec, id: override }
}

/**
 * Call types whose model is settled in this file and cannot be moved by
 * configuration. The draft judge is the only one.
 *
 * It is the check standing between a merchant and an article that should not
 * go out, and a grader quietly swapped for the cheap model is not a check on
 * anything. Until this existed, one variable that ships in `.env.example`
 * could do exactly that, with nothing in the code or in CI noticing — and the
 * spending would still have been reported at the expensive model's prices, so
 * it would not even have shown up as a saving. Founder decision, 2026-09-04.
 *
 * Every other call type still honours `ANTHROPIC_MODEL_<TIER>`: pinning a
 * model per environment without a code change is legitimate everywhere else.
 * The consequence is deliberate — pinning the strong tier moves the writer and
 * leaves the judge where it is, which is the direction that stays safe.
 */
const PINNED_CALL_TYPES: ReadonlySet<string> = new Set(['judge'])

export type LlmCallTypeWithTier = keyof typeof CALL_TYPE_TIER

/** The model one call runs on. The only resolution the client ever performs. */
export function resolveModelForCallType(
  callType: LlmCallTypeWithTier,
  env: NodeJS.ProcessEnv = process.env,
): ModelSpec {
  const tier = CALL_TYPE_TIER[callType]
  if (PINNED_CALL_TYPES.has(callType)) return MODELS[tier]
  return resolveModel(tier, env)
}

/** Priced from the model's own rates. Cache replays are costed at zero by the caller. */
export function usdCost(spec: ModelSpec, inputTokens: number, outputTokens: number): number {
  const cost =
    (inputTokens / 1_000_000) * spec.inputUsdPerMTok +
    (outputTokens / 1_000_000) * spec.outputUsdPerMTok
  // Six decimals: a Haiku distillation call is fractions of a cent, and rounding
  // to four would report a real cost as zero.
  return Math.round(cost * 1_000_000) / 1_000_000
}

export function specForModelId(modelId: string): ModelSpec | undefined {
  return Object.values(MODELS).find((m) => m.id === modelId)
}

/**
 * `LlmRequest.model` lets a caller override the model for one call. Audit
 * `docs/audits/T0.5.md` finding 8: the previous version applied the override to
 * the model's *name* but kept the tier's *prices*, so overriding a Haiku call
 * with Sonnet recorded roughly half the real cost, and it skipped the "no
 * moving aliases" check that the environment-variable path performs.
 *
 * The auditor's preferred fix was to delete `LlmRequest.model` outright, but it
 * is declared in a frozen contract (`packages/core/src/contracts/llm.ts`) other
 * lanes build against, so this card takes the alternative it offered: route the
 * override through a lookup that only accepts a known, priced, explicitly-named
 * model.
 */
export function overrideModel(modelId: string): ModelSpec {
  if (ALIAS_PATTERN.test(modelId)) {
    throw new Error(
      `LlmRequest.model="${modelId}" looks like a moving alias. Model ids must be explicit, or an artefact stamped with one cannot be reproduced later.`,
    )
  }
  const spec = specForModelId(modelId)
  if (!spec) {
    throw new Error(
      `LlmRequest.model="${modelId}" is not in the model registry, so the call would be priced at another model's rates and misreport spend. Add it to MODELS with its prices, or drop the override.`,
    )
  }
  return spec
}

/**
 * Input tokens for a call whose usage figures never came back. Anthropic bills
 * for work performed, so a request that reached the API and then failed still
 * costs — estimated here at the same ≈4-characters-per-token rate the test
 * double uses. Recorded spend on a failed call is therefore an approximation,
 * and is marked as one.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

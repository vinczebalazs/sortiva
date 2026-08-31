/**
 * main §14.2 — "model IDs are explicit config values (never 'latest' aliases)";
 * §14.7 — every capture carries the model id. §15 fixes which tier does what:
 * Haiku for product distillation and the preview card, Sonnet for the persona,
 * seed keywords, drafting and the Gate 3 judge — and the judge is **never**
 * downgraded (main §8.4, §14.4, invariant 11).
 *
 * Prices are per million tokens, used to cost cache replays at zero and to let
 * the test doubles account spend without a network call (main §14.7).
 */

export interface ModelSpec {
  readonly id: string
  readonly inputUsdPerMTok: number
  readonly outputUsdPerMTok: number
  /**
   * The current Sonnet generation rejects `temperature`/`top_p` with a 400, so
   * the wrapper must not forward one. main §3.3 asks for "temperature low" on
   * the preview call, which runs on Haiku, where it is accepted.
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

/** main §15 — which tier each call type runs on. */
export const CALL_TYPE_TIER = {
  distill: 'haiku',
  preview: 'haiku',
  persona: 'sonnet',
  seeds: 'sonnet',
  judge: 'sonnet',
  intent_gap: 'sonnet',
  optimize_reco: 'sonnet',
} as const satisfies Record<string, ModelTier>

/**
 * Env overrides exist so a model can be pinned per environment without a code
 * change, but they must still name an id explicitly — an alias is rejected, so
 * "latest" cannot slip in through configuration either.
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
      `ANTHROPIC_MODEL_${tier.toUpperCase()}="${override}" looks like an alias. main §14.2 requires explicit model ids so every artefact is reproducible.`,
    )
  }
  return { ...spec, id: override }
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

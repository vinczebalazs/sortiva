/**
 * The seed-keyword call: candidate search terms derived from the store's
 * business profile and its product families.
 *
 * The answer is not written anywhere a merchant reads directly. Every term goes
 * to the paid search vendor to be priced, and only the terms that survive that
 * become the draft keyword set. So the contract here is deliberately narrow —
 * a list of strings and nothing else — because anything richer would be a
 * judgement the model is not in a position to make and the vendor answers for
 * free.
 */

export interface SeedKeywordsDraft {
  readonly keywords: readonly string[]
}

/**
 * A completion that does not fit is retried once with the validation error
 * attached and then fails; we never keep the half that parsed.
 *
 * The bounds are wide on purpose. They are a sanity check on the shape of the
 * answer, not the product's own limits — how many candidates are asked for and
 * how many survive are thresholds in `packages/rules`, applied after this.
 */
export const SEED_KEYWORDS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['keywords'],
  properties: {
    keywords: {
      type: 'array',
      minItems: 1,
      maxItems: 60,
      items: { type: 'string', minLength: 1, maxLength: 120 },
    },
  },
} as const

/** Output cap for the seed call. A list of short phrases; anything longer is a model that has started explaining itself. */
export const SEED_KEYWORDS_MAX_OUTPUT_TOKENS = 1_200

/** The most families described in the brief, largest first. Beyond this the brief stops adding information and starts adding cost. */
export const SEED_BRIEF_MAX_FAMILIES = 15

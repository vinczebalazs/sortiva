/**
 * The business profile: who this store is, who it sells to, and how it sounds.
 *
 * One object, produced once during onboarding, that the merchant then confirms
 * or corrects. Everything written for them afterwards is written in the
 * language, for the audience and in the register this object names, so a wrong
 * value here is not a cosmetic error — it is every article being aimed at the
 * wrong reader.
 */

/** What the model is asked for, exactly. */
export interface PersonaDraft {
  /** Two to four sentences, written in the store's own language. */
  readonly business_description: string
  /** The broad categories the store sells in, in the store's own language. */
  readonly product_categories: readonly string[]
  /** ISO-639-1. */
  readonly main_language: string
  /** ISO-3166 alpha-2. */
  readonly country: string
  readonly audience: string
  /** How the brand sounds — "playful", "clinical", "premium". */
  readonly brand_tone: string
}

/**
 * The contract the answer is held to on every call. A completion that does not
 * fit is retried once with the validation error attached and then fails as
 * `failed_validation`; we never keep the half that parsed.
 *
 * The two code fields carry patterns rather than being merely "a string". They
 * are passed straight to the search-data vendor as location and language
 * parameters, and a model that answered "German" instead of "de" would not
 * fail — it would silently return another market's numbers, which is the
 * failure that is hardest to notice and most expensive to act on.
 */
export const PERSONA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'business_description',
    'product_categories',
    'main_language',
    'country',
    'audience',
    'brand_tone',
  ],
  properties: {
    business_description: { type: 'string', minLength: 1 },
    product_categories: { type: 'array', items: { type: 'string' } },
    main_language: { type: 'string', pattern: '^[a-z]{2,3}$' },
    country: { type: 'string', pattern: '^[A-Z]{2}$' },
    audience: { type: 'string' },
    brand_tone: { type: 'string' },
  },
} as const

/**
 * The stored profile: the model's answer with the two code fields settled by
 * the detection chain, plus where each of them came from.
 *
 * The provenance is not decoration. When a merchant tells us at confirmation
 * that we have their country wrong, the useful next question is which piece of
 * evidence said otherwise — their own Shopify setting, their homepage markup,
 * or a guess from their web address — and that is only answerable if we wrote
 * it down at the time.
 */
export interface Persona {
  readonly description: string
  readonly productCategories: readonly string[]
  readonly language: string
  readonly country: string
  readonly audience: string
  readonly tone: string
  /** Which link in the detection chain settled the language and the country. */
  readonly languageSource: string
  readonly countrySource: string
  /** Invariant 25: every model artefact names the instructions and the model behind it. */
  readonly promptVersion: string
  readonly modelId: string
}

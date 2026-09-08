/**
 * The fact sheet: what a product actually *is*, with the marketing removed.
 *
 * "Premium quality Italian leather" becomes `material: "leather"` and the
 * "premium" dies. "Perfect for any occasion" becomes nothing at all. A field
 * the description does not support stays `null` — an empty field is a fact
 * about the product, not a failure of the extraction, and it is what tells us a
 * store's pages are too thin to write from.
 *
 * This object is the *only* thing about a product's words that anything
 * downstream ever sees. The description itself is quarantined.
 */

/** One product's fact sheet, as stored and as everything downstream reads it. */
export interface FactSheet {
  readonly material: string | null
  readonly dimensions: string | null
  readonly weight: string | null
  readonly capacity: string | null
  readonly compatibility: readonly string[]
  /** Uses the text itself states. Never a use we thought of. */
  readonly use_cases_stated: readonly string[]
  readonly care: string | null
  /**
   * The merchant's own names for the options defined on this product — "Size",
   * "Colour". Copied from the store's option definitions rather than
   * extracted, because they are already structured and a model asked to name
   * an axis would sooner or later name one nobody chose.
   *
   * Names only, and the values are dropped on purpose: a sheet describes one
   * product, so listing them would say a shoe is black *and* tan. And a name
   * lands here whenever the merchant *defined* the option — whether they
   * filled it with twelve values, with one, or with none at all. Only
   * Shopify's `Title: Default Title` placeholder is removed. So a shop selling
   * one black shoe and a shop selling five colourways both store "Colour", and
   * nothing in this field tells them apart: it says an option exists, never
   * that a choice does.
   */
  readonly variant_axes: readonly string[]
  /** Merged from the product's variants, never taken from the model. */
  readonly price_range: { readonly min: number; readonly max: number } | null
  readonly certifications: readonly string[]
  readonly origin: string | null
  /**
   * Statements that could be shown to be false — "waterproof to 10m", "holds 12
   * bottles". A claim nobody could check is not a claim, it is an adjective.
   */
  readonly verifiable_claims: readonly string[]
  /** Whether marketing language was present and dropped. Part of how a store's own substance is judged. */
  readonly fluff_discarded: boolean
  /** How many facts this sheet holds. Counted by us from the sheet, never taken from the model. */
  readonly fact_count: number
}

/**
 * The half of the sheet the model produces.
 *
 * `price_range` and `variant_axes` are deliberately absent: they come from the
 * product's structured variant data, which is already factual and needs no
 * distillation, and asking a model for a price is inviting the one fabrication
 * with a currency symbol on it. `fact_count` is absent for the same reason in
 * reverse — a model counting its own output is a number that can disagree with
 * the object it describes.
 */
export type ExtractedFacts = Omit<FactSheet, 'variant_axes' | 'price_range' | 'fact_count'>

/** The text-derived fields, in the order the sheet lists them. */
export const EXTRACTED_FIELDS = [
  'material',
  'dimensions',
  'weight',
  'capacity',
  'compatibility',
  'use_cases_stated',
  'care',
  'certifications',
  'origin',
  'verifiable_claims',
] as const

/**
 * The contract the model's answer is held to on every call. A completion that
 * does not fit is retried once with the error attached and then fails as
 * `failed_validation` — we never keep the half that parsed.
 *
 * `additionalProperties: false` is doing real work here: it is what stops a
 * model that has decided a product also has a `colour` from inventing a field
 * nothing downstream knows how to read.
 */
export const DISTILL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [...EXTRACTED_FIELDS, 'fluff_discarded'],
  properties: {
    material: { type: ['string', 'null'] },
    dimensions: { type: ['string', 'null'] },
    weight: { type: ['string', 'null'] },
    capacity: { type: ['string', 'null'] },
    compatibility: { type: 'array', items: { type: 'string' } },
    use_cases_stated: { type: 'array', items: { type: 'string' } },
    care: { type: ['string', 'null'] },
    certifications: { type: 'array', items: { type: 'string' } },
    origin: { type: ['string', 'null'] },
    verifiable_claims: { type: 'array', items: { type: 'string' } },
    fluff_discarded: { type: 'boolean' },
  },
} as const

/** A fact sheet with nothing in it: what a product with no usable description gets. */
export function emptyFactSheet(): FactSheet {
  return {
    material: null,
    dimensions: null,
    weight: null,
    capacity: null,
    compatibility: [],
    use_cases_stated: [],
    care: null,
    variant_axes: [],
    price_range: null,
    certifications: [],
    origin: null,
    verifiable_claims: [],
    fluff_discarded: false,
    fact_count: 0,
  }
}

/**
 * How many facts a sheet holds.
 *
 * Every populated scalar field counts once, and every entry of every list
 * counts once — three stated use cases are three things we know about the
 * product, and counting them as one would make a richly described product look
 * the same as a bare one. `fluff_discarded` is not a fact about the product, so
 * it does not count; neither do the merged price and variant axes, which are
 * true of every product in every store and would flatten the difference the
 * score exists to show.
 */
export function countFacts(facts: ExtractedFacts): number {
  let count = 0
  for (const field of EXTRACTED_FIELDS) {
    const value = facts[field]
    if (Array.isArray(value)) count += value.filter((entry) => entry.trim() !== '').length
    else if (typeof value === 'string' && value.trim() !== '') count += 1
  }
  return count
}

/**
 * How many of the sheet's ten extractable fields the description actually
 * supported. The richness roll-up reads this rather than `fact_count`: a
 * product whose description lists nine compatible devices and nothing else
 * knows one thing about itself, not nine.
 */
export function countPopulatedFields(facts: ExtractedFacts): number {
  let count = 0
  for (const field of EXTRACTED_FIELDS) {
    const value = facts[field]
    if (Array.isArray(value)) {
      if (value.some((entry) => entry.trim() !== '')) count += 1
    } else if (typeof value === 'string' && value.trim() !== '') count += 1
  }
  return count
}

/**
 * Which of the ten extractable fields the description never supported — the
 * merchant's own to-do list for one product, written out.
 *
 * The inverse of `countPopulatedFields`, and it must stay the inverse: a field
 * counted as populated here but missing there would show a merchant a product
 * marked well-described alongside a list of what it is missing.
 */
export function missingFactFields(
  facts: ExtractedFacts,
): readonly (typeof EXTRACTED_FIELDS)[number][] {
  return EXTRACTED_FIELDS.filter((field) => {
    const value = facts[field]
    if (Array.isArray(value)) return !value.some((entry) => entry.trim() !== '')
    return !(typeof value === 'string' && value.trim() !== '')
  })
}

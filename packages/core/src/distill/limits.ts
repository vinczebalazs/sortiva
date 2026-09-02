/**
 * What one product's distillation may cost, in one file so the numbers that
 * decide the price of reading a catalogue are readable together.
 *
 * Distillation is the largest model spend in onboarding — one call per product,
 * hundreds of products — so the input is capped rather than left to the length
 * of whatever a merchant pasted into their description editor.
 *
 * These deliberately do not live in `packages/rules`: that package is the
 * Opportunity Engine's threshold layer, holding the numbers that decide what we
 * write about, and it is owned by another lane. Nothing here decides anything a
 * merchant sees.
 */

/**
 * How much of one description reaches the model, in characters, at the usual
 * four-characters-per-token. Roughly 1.5k tokens of input: long enough for a
 * detailed spec table, short enough that a merchant with a 40,000-character
 * description does not cost forty times what everyone else does.
 *
 * Descriptions are truncated rather than dropped, because the facts are almost
 * always near the top — the fluff is what runs long.
 */
export const DISTILL_MAX_INPUT_CHARS = 6_000

/**
 * The output budget. A fact sheet with every field populated and a handful of
 * claims is a few hundred tokens; this leaves room for a verbose one without
 * paying for an essay.
 */
export const DISTILL_MAX_OUTPUT_TOKENS = 1_024

/**
 * Extraction, not composition: the same value that decides between "leather"
 * and "premium leather" every time it is asked. Haiku accepts a temperature.
 */
export const DISTILL_TEMPERATURE = 0

/**
 * Below this much usable description text there is nothing to extract, and the
 * model call is skipped entirely — the product gets an empty fact sheet, which
 * is a fact about the product rather than a failure. Two words of description
 * cannot yield a material or a dimension, and paying to be told so for every
 * thin product in a large catalogue is the most avoidable cost in the step.
 */
export const DISTILL_MIN_INPUT_CHARS = 40

/**
 * What makes a sentence one that has to carry a citation.
 *
 * The point of scanning for this independently is that the writer's markers
 * are not trusted: if the check only looked at sentences that already had a
 * `[[cN]]` on them, forgetting to cite would be the cheapest way to get an
 * unsupported claim past the gate. So the detector reads the sentence itself
 * and decides whether it is making a checkable assertion — and an uncited one
 * fails.
 *
 * **Everything here is found by shape, so it works in every language a store
 * publishes in.** Numbers, measurements, percentages and durations look the
 * same in Danish as in English, and a merchant abroad is held to exactly the
 * bar a merchant here is.
 *
 * Superlatives, absolutes, attributed statements and comparisons are *not*
 * detected here and deliberately have no list behind them: a word list only
 * works in the language it was written for, and one per launch language is an
 * open-ended cost that would leave every unlisted language quietly weaker.
 * The instruction to cite those four now lives in the writing prompt, which
 * asks for it in whatever language the article is being written in. The cost
 * was chosen knowingly: for those four, nothing deterministic stands behind
 * the model. See DECISIONS 2026-09-04.
 */

export const CHECKABLE_KINDS = ['number', 'measurement', 'percentage', 'duration'] as const

export type CheckableKind = (typeof CHECKABLE_KINDS)[number]

/**
 * A bare number, a number with a unit, a percentage, a duration. Written as
 * separate patterns rather than one, because the citation message should be
 * able to say which kind of checkable content it found.
 */
const NUMBER = /(?<![\p{L}\d])\d+(?:[.,]\d+)?(?![\p{L}\d])/u
const PERCENTAGE = /\d+(?:[.,]\d+)?\s*(?:%|percent|per cent)/iu
const UNIT_WORDS =
  'mm|cm|m|km|in|inch|inches|ft|feet|g|kg|lb|lbs|oz|ml|l|litre|litres|liter|liters|w|kw|v|hz|db|°c|°f|c|f|gsm|denier|thread count'
const MEASUREMENT = new RegExp(`\\d+(?:[.,]\\d+)?\\s*(?:${UNIT_WORDS})(?![\\p{L}])`, 'iu')
const DURATION =
  /\d+(?:[.,]\d+)?\s*(?:second|seconds|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\b/iu
/**
 * A written-out duration — "lasts three years" carries a claim just as "lasts
 * 3 years" does.
 *
 * "One" is deliberately absent and the unit must be plural: "one day you will
 * want a bigger pack" is an idiom, not a measurement, and reading it as one
 * would make a citation compulsory on a sentence that asserts nothing.
 *
 * This is the one pattern here that reads words rather than digits, and it
 * widens the numeric rule rather than being a rule of its own: a store
 * publishing in another language is no worse off than it would be without it,
 * because a duration written in digits is caught either way.
 */
const WORD_DURATION =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten)\s+(?:seconds|minutes|hours|days|weeks|months|years)\b/iu

/**
 * Every kind of checkable content in one sentence. An empty result means the
 * sentence states no figure a citation could be checked against — which is not
 * the same as stating nothing: a superlative or a comparison is still a claim
 * the writing prompt requires a citation for, it is simply not one this
 * function can see in any language.
 */
export function checkableKindsIn(sentence: string): CheckableKind[] {
  const kinds = new Set<CheckableKind>()

  if (PERCENTAGE.test(sentence)) kinds.add('percentage')
  if (MEASUREMENT.test(sentence)) kinds.add('measurement')
  if (DURATION.test(sentence) || WORD_DURATION.test(sentence.toLowerCase())) kinds.add('duration')
  if (NUMBER.test(sentence) && !kinds.has('measurement') && !kinds.has('percentage') && !kinds.has('duration')) {
    kinds.add('number')
  }

  return [...kinds]
}

/** Every number in a sentence, normalised so "1,5" and "1.5" compare equal. */
export function numbersIn(text: string): number[] {
  const matches = text.matchAll(/(?<![\p{L}\d])(\d+(?:[.,]\d+)?)(?![\p{L}\d])/gu)
  return [...matches].map((m) => Number(m[1]!.replace(',', '.'))).filter((n) => Number.isFinite(n))
}

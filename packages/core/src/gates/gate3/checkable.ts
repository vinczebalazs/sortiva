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
 * **Language limitation, stated rather than hidden:** numbers, units,
 * percentages and durations are found by shape and work in any language; the
 * word lists below (superlatives, absolutes, attribution, comparison) are
 * English. A store publishing in another language gets the shape-based
 * detectors only until a list exists for its language — see DECISIONS
 * 2026-09-03 T4.4. `lexiconFor` is the single place that decides which a
 * given article gets.
 */

export const CHECKABLE_KINDS = [
  'number',
  'measurement',
  'percentage',
  'duration',
  'superlative',
  'absolute',
  'attributed_statement',
  'comparison',
] as const

export type CheckableKind = (typeof CHECKABLE_KINDS)[number]

export interface CheckableLexicon {
  readonly languageCode: string
  readonly superlatives: readonly string[]
  /** The words §3 of `docs/content-pointers.md` permits only on a strongly-supported claim. */
  readonly absolutes: readonly string[]
  readonly attributions: readonly string[]
  readonly comparisons: readonly string[]
  /** Words that mark a sentence as advice rather than a statement of fact. */
  readonly recommendationVerbs: readonly string[]
  /** Words that reverse a sentence's polarity, for the contradiction grouping. */
  readonly negations: readonly string[]
}

const ENGLISH: CheckableLexicon = {
  languageCode: 'en',
  superlatives: [
    'best',
    'worst',
    'largest',
    'smallest',
    'strongest',
    'weakest',
    'fastest',
    'slowest',
    'cheapest',
    'lightest',
    'heaviest',
    'longest',
    'shortest',
    'most durable',
    'most popular',
    'the most',
    'the least',
    'number one',
    'leading',
    'unrivalled',
    'unrivaled',
  ],
  absolutes: [
    'always',
    'never',
    'must',
    'cannot',
    "can't",
    'every',
    'all',
    'the best',
    'the most',
    'the only',
    'guarantees',
    'guaranteed',
    'eliminates',
    'prevents',
    'ensures',
    'no exceptions',
  ],
  attributions: [
    'according to',
    'research shows',
    'studies show',
    'experts say',
    'experts agree',
    'reported by',
    'as reported',
    'a study',
    'the manufacturer says',
    'reviewers',
    'industry data',
  ],
  comparisons: [
    'more than',
    'less than',
    'fewer than',
    'compared to',
    'compared with',
    'better than',
    'worse than',
    'heavier than',
    'lighter than',
    'larger than',
    'smaller than',
    'longer than',
    'shorter than',
    'faster than',
    'slower than',
    'twice as',
    'half as',
    'outlasts',
    'outperforms',
    ' vs ',
    ' vs. ',
    'versus',
  ],
  recommendationVerbs: ['recommend', 'we suggest', 'choose', 'go for', 'pick', 'opt for', 'is the right choice'],
  negations: ['not', "don't", 'do not', 'never', 'avoid', 'unsuitable', 'no', 'rather than', 'instead of'],
}

const LEXICONS: Readonly<Record<string, CheckableLexicon>> = { en: ENGLISH }

/**
 * The word-list checks for this article's language, or null when we have no
 * list for it. Null is not "everything passes" — the shape-based detectors
 * below still run, and the gate decision records that the language checks did
 * not.
 */
export function lexiconFor(languageCode: string | null | undefined): CheckableLexicon | null {
  if (!languageCode) return null
  return LEXICONS[languageCode.slice(0, 2).toLowerCase()] ?? null
}

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
 */
const WORD_DURATION =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten)\s+(?:seconds|minutes|hours|days|weeks|months|years)\b/iu

/**
 * Words ending in "-er" that are not comparatives. Without this, "rather
 * than", "other than" and "whether" all read as comparisons, and a citation
 * becomes compulsory on ordinary connective prose.
 */
const NOT_COMPARATIVES = /\b(?:rather|other|whether|either|neither|further|however|altogether|together)\s+than\b/giu

/**
 * Absolute words that are ordinary time idioms rather than claims. "Carried
 * every day" is a description of habit; "every model prevents leaks" is the
 * kind of sentence the absolute rule exists for.
 */
const ABSOLUTE_TIME_IDIOMS = /\b(?:every|all)\s+(?:day|week|month|year|season|morning|evening|night)\b/giu

function containsAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle))
}

/**
 * Every kind of checkable content in one sentence. An empty result means the
 * sentence asserts nothing a citation could support — framing, a transition,
 * a question — and needs no marker.
 */
export function checkableKindsIn(sentence: string, lexicon: CheckableLexicon | null): CheckableKind[] {
  const kinds = new Set<CheckableKind>()
  const lower = sentence.toLowerCase()

  if (PERCENTAGE.test(sentence)) kinds.add('percentage')
  if (MEASUREMENT.test(sentence)) kinds.add('measurement')
  if (DURATION.test(sentence) || WORD_DURATION.test(lower)) kinds.add('duration')
  if (NUMBER.test(sentence) && !kinds.has('measurement') && !kinds.has('percentage') && !kinds.has('duration')) {
    kinds.add('number')
  }

  if (lexicon) {
    const forAbsolutes = lower.replace(ABSOLUTE_TIME_IDIOMS, ' ')
    const forComparisons = lower.replace(NOT_COMPARATIVES, ' ')
    if (containsAny(lower, lexicon.superlatives)) kinds.add('superlative')
    if (containsWord(forAbsolutes, lexicon.absolutes)) kinds.add('absolute')
    if (containsAny(lower, lexicon.attributions)) kinds.add('attributed_statement')
    if (containsAny(forComparisons, lexicon.comparisons) || /\b\w+er than\b/.test(forComparisons)) {
      kinds.add('comparison')
    }
  }

  return [...kinds]
}

/**
 * Whole-word matching for the absolute list specifically: "all" inside
 * "allow" and "must" inside "mustard" are not absolute language, and a
 * substring match on a short word list produces exactly that failure. The
 * hyphen counts as part of a word here — "all-rounder" and "self-cleaning" are
 * single words, and treating the hyphen as a boundary would read an absolute
 * into every compound that happens to start with one. Phrases ("the only")
 * fall back to a substring test, which is safe because they already carry
 * their own boundaries.
 */
export function containsWord(lowerText: string, words: readonly string[]): boolean {
  return words.some((word) => {
    if (word.includes(' ')) return lowerText.includes(word)
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?<![\\p{L}\\d-])${escaped}(?![\\p{L}\\d-])`, 'u').test(lowerText)
  })
}

/** The absolute words actually present, so a failure can quote them back. */
export function absolutesIn(sentence: string, lexicon: CheckableLexicon | null): string[] {
  if (!lexicon) return []
  const lower = sentence.toLowerCase().replace(ABSOLUTE_TIME_IDIOMS, ' ')
  return lexicon.absolutes.filter((word) => containsWord(lower, [word]))
}

/** Every number in a sentence, normalised so "1,5" and "1.5" compare equal. */
export function numbersIn(text: string): number[] {
  const matches = text.matchAll(/(?<![\p{L}\d])(\d+(?:[.,]\d+)?)(?![\p{L}\d])/gu)
  return [...matches].map((m) => Number(m[1]!.replace(',', '.'))).filter((n) => Number.isFinite(n))
}

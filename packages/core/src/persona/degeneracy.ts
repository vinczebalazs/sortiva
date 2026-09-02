/**
 * Whether the model actually described *this* store.
 *
 * The failure this catches is not a wrong answer, it is an empty one. A model
 * that has been handed a thin brief — a store with no about page, no best
 * sellers and one family — will still write two confident sentences, and those
 * sentences will say "this store offers a range of high-quality products for
 * discerning customers". That passes every schema check, and it is worthless:
 * everything written afterwards is aimed at a business we have not identified.
 *
 * So the description is held to four plain conditions rather than graded. Each
 * one names what went wrong, because "degenerate" on its own is not something
 * anyone can act on.
 */

export type DescriptionVerdict =
  | 'substantive'
  /** Nothing at all, or whitespace. */
  | 'empty'
  /** Present, but too little to be two sentences about a business. */
  | 'too_short'
  /** The spec asks for two to four sentences; one is a label and six is an essay. */
  | 'wrong_sentence_count'
  /** True of any shop: it names nothing this store sells or stands for. */
  | 'generic'
  /** The brief handed back with the headings still attached. */
  | 'echoes_the_brief'

/**
 * Below this, a "description" is a label. Two sentences about a business in any
 * language run past it comfortably; the shortest genuine answer seen in the
 * smoke set is roughly twice this.
 */
const MIN_DESCRIPTION_CHARS = 80

/** Sentence-ending punctuation, Latin and CJK. */
const SENTENCE_END = /[.!?。！？]+/

/** Headings from the brief. Their presence means the answer is the question. */
const BRIEF_HEADINGS = [
  'Product families:',
  'Best sellers, in order:',
  'Homepage text:',
  'About page text:',
  'Store address:',
]

export function countSentences(text: string): number {
  return text
    .split(SENTENCE_END)
    .map((part) => part.trim())
    .filter((part) => part !== '').length
}

/**
 * Terms from the store's own catalogue that a real description of it would be
 * expected to touch: its family names, its best sellers, its own brand.
 *
 * Matching is on words of three characters or more, lower-cased, so "Trail
 * Running Shoes" is satisfied by a description that says "running shoes" and
 * not by one that says "shoes and more" — and a two-letter word, which in some
 * languages is every second word, cannot satisfy it by accident.
 */
export function storeVocabulary(terms: readonly string[]): string[] {
  const words = new Set<string>()
  for (const term of terms) {
    for (const word of term.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (word.length >= 3) words.add(word)
    }
  }
  return [...words]
}

export function describesTheStore(
  description: string | null | undefined,
  vocabulary: readonly string[],
): DescriptionVerdict {
  const text = (description ?? '').trim()
  if (text === '') return 'empty'
  if (BRIEF_HEADINGS.some((heading) => text.includes(heading))) return 'echoes_the_brief'
  if (text.length < MIN_DESCRIPTION_CHARS) return 'too_short'

  const sentences = countSentences(text)
  if (sentences < 2 || sentences > 4) return 'wrong_sentence_count'

  // A store we know nothing about has no vocabulary to match, and failing it
  // for that would be marking the store down rather than the description.
  if (vocabulary.length === 0) return 'substantive'

  const lowered = text.toLowerCase()
  return vocabulary.some((word) => lowered.includes(word)) ? 'substantive' : 'generic'
}

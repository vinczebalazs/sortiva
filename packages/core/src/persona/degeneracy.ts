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
 * Below this, a "description" is a label rather than a description. Two
 * sentences about a business in an alphabetic language run past it comfortably.
 */
const MIN_DESCRIPTION_CHARS = 80

/**
 * The same bar for a language that writes a word in one or two characters.
 *
 * Japanese says in forty characters what German needs a hundred and twenty for,
 * so a single character count would mark every genuine Japanese description as
 * too short — the same mistake, in the other direction, as holding a German
 * description to a Japanese length.
 */
const MIN_DESCRIPTION_CHARS_DENSE = 30

/** How much of the text has to be in a dense script before it is judged as one. */
const DENSE_SHARE = 0.3

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
 * Scripts that write a whole word in one or two characters. In Japanese, 急須
 * ("teapot") is two characters and an entire noun; in an alphabet, two letters
 * is usually a preposition.
 */
const DENSE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * Terms from the store's own catalogue that a real description of it would be
 * expected to touch: its family names and its best sellers.
 *
 * Matching is on words long enough to mean something, lower-cased, so "Trail
 * Running Shoes" is satisfied by a description that says "running shoes" and
 * not by one that says "shoes and more" — a two-letter word, which in an
 * alphabetic language is every second word, cannot satisfy it by accident. The
 * bar is two characters rather than three for scripts where two characters is a
 * noun rather than a particle, because holding Japanese to an English word
 * length would mark every Japanese store's description as saying nothing.
 */
export function storeVocabulary(terms: readonly string[]): string[] {
  const words = new Set<string>()
  for (const term of terms) {
    for (const word of term.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      const minimum = DENSE_SCRIPT.test(word) ? 2 : 3
      if (word.length >= minimum) words.add(word)
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
  if (text.length < minimumLengthFor(text)) return 'too_short'

  const sentences = countSentences(text)
  if (sentences < 2 || sentences > 4) return 'wrong_sentence_count'

  // A store we know nothing about has no vocabulary to match, and failing it
  // for that would be marking the store down rather than the description.
  if (vocabulary.length === 0) return 'substantive'

  const lowered = text.toLowerCase()
  return vocabulary.some((word) => lowered.includes(word)) ? 'substantive' : 'generic'
}

/** The length bar this text's own script is held to. */
function minimumLengthFor(text: string): number {
  const letters = text.match(/\p{L}/gu)?.length ?? 0
  if (letters === 0) return MIN_DESCRIPTION_CHARS
  const dense = text.match(new RegExp(DENSE_SCRIPT.source, 'gu'))?.length ?? 0
  return dense / letters >= DENSE_SHARE ? MIN_DESCRIPTION_CHARS_DENSE : MIN_DESCRIPTION_CHARS
}

import { DISTILL_MAX_INPUT_CHARS } from './limits'

/**
 * Turning a product description into the text the extraction reads.
 *
 * This is the one place a merchant's raw description is handled at all, and it
 * is a funnel rather than a passage: HTML goes in, plain text comes out, and
 * what comes out is bounded. Nothing downstream of the fact sheet ever sees
 * either side of it.
 *
 * Shopify descriptions are pasted from everywhere — Word, other shop platforms,
 * page builders — so they arrive full of empty divs, inline styles, tracking
 * pixels and occasionally a whole `<script>`. Feeding that to a model is paying
 * for markup by the token and inviting instructions hidden in an attribute.
 */

/** Elements whose *contents* are not description text, however they are formatted. */
const DROPPED_ELEMENTS = /<(script|style|noscript|template|iframe|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi

/** Tags that separate one thought from the next; everything else closes up. */
const BLOCK_TAGS = /<\/?(p|div|br|li|tr|h[1-6]|section|article|table|ul|ol|dl|dt|dd)\b[^>]*>/gi

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  deg: '°',
  times: '×',
  eacute: 'é',
  egrave: 'è',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  szlig: 'ß',
}

/**
 * The description as plain text: markup gone, entities resolved, whitespace
 * collapsed, and never longer than the input budget.
 *
 * Truncation is at the end rather than the middle because a description's facts
 * are almost always near the top — a spec table, then the story. It is also
 * cut at a word boundary, so the model is not handed a half-written number and
 * left to guess the rest of it.
 */
export function descriptionText(bodyHtml: string | null | undefined): string {
  if (!bodyHtml) return ''

  const withoutDropped = bodyHtml.replace(DROPPED_ELEMENTS, ' ')
  const withBreaks = withoutDropped.replace(BLOCK_TAGS, '\n')
  const withoutTags = withBreaks.replace(/<[^>]*>/g, '')
  const decoded = decodeEntities(withoutTags)

  const collapsed = decoded
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
    .trim()

  return truncateAtWord(collapsed, DISTILL_MAX_INPUT_CHARS)
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1))
      // A code point out of range is left as written rather than replaced with
      // a replacement character: the literal text is at least what the merchant
      // typed.
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

function truncateAtWord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const cut = text.slice(0, maxChars)
  const lastBreak = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'))
  return (lastBreak > maxChars * 0.8 ? cut.slice(0, lastBreak) : cut).trimEnd()
}

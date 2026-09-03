import { extractHeadings } from '../inventory/html'
import type { CompetitorAngle } from './evidence-pack'

/**
 * Turning a fetched competitor page's markup into what the evidence pack
 * carries: its headings (what it chose to cover — `packages/core/src/inventory/html.ts`'s
 * existing extractor, reused rather than reimplemented), a short excerpt an
 * external-fact claim may quote from, and a word count for the SERP-matched
 * length target (main §9.2).
 *
 * Regexes rather than an HTML parser, on the same reasoning
 * `inventory/html.ts` already states for the same kind of input: one field
 * read a handful of times, not a document to be understood.
 */

const TAG = /<[^>]*>/g
const WHITESPACE = /\s+/g

function stripHtmlToText(html: string): string {
  return html.replace(TAG, ' ').replace(WHITESPACE, ' ').trim()
}

export function wordCountOf(text: string): number {
  const trimmed = text.trim()
  return trimmed === '' ? 0 : trimmed.split(WHITESPACE).length
}

/** The opening of the readable text — long enough for a real quote to survive, short enough to keep the prompt cheap. */
export function excerptOf(text: string, maxChars = 1500): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`
}

export function buildCompetitorAngle(input: {
  readonly url: string
  readonly domain: string
  readonly position: number
  readonly bodyHtml: string
}): { readonly angle: CompetitorAngle; readonly wordCount: number } {
  const text = stripHtmlToText(input.bodyHtml)
  return {
    angle: {
      url: input.url,
      domain: input.domain,
      position: input.position,
      headings: extractHeadings(input.bodyHtml),
      excerpt: excerptOf(text),
    },
    wordCount: wordCountOf(text),
  }
}

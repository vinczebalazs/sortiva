import type { Draft } from '../../generation/draft'

/**
 * Every Gate 3 check reads the draft as prose, and each of them needs the
 * same three things: where a piece of text sits (so a failure can name the
 * section a merchant would have to look at), the sentences inside it, and the
 * text with the writer's citation markers taken back out. Doing that once
 * here is what keeps a dozen checks from each inventing their own idea of
 * what a sentence is — and disagreeing about which one failed.
 */

export type BlockKind = 'title' | 'intro' | 'section' | 'faq'

export interface ProseBlock {
  readonly kind: BlockKind
  /** Position among blocks of this kind, from 0. */
  readonly index: number
  /** What a merchant would call this part of the article: "Intro", "Section 2 — Fit". */
  readonly label: string
  /** The section heading or FAQ question; null for the intro. */
  readonly heading: string | null
  readonly text: string
}

export interface ProseSentence {
  readonly block: ProseBlock
  readonly index: number
  /** As written, markers and all. */
  readonly text: string
  /** The same sentence with `[[cN]]` and `{{pN}}` removed — what a reader sees. */
  readonly plain: string
  /** Claim ids cited in this sentence, in order. */
  readonly citedClaimIds: readonly string[]
}

const CLAIM_MARKER = /\[\[\s*([a-zA-Z0-9_]+)\s*\]\]/g
const PRODUCT_MARKER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

export function stripMarkers(text: string): string {
  return text.replace(CLAIM_MARKER, '').replace(PRODUCT_MARKER, '')
}

export function citedClaimIdsIn(text: string): string[] {
  return [...text.matchAll(CLAIM_MARKER)].map((m) => m[1]!)
}

export function blocksOf(draft: Draft): ProseBlock[] {
  const blocks: ProseBlock[] = [{ kind: 'intro', index: 0, label: 'Intro', heading: null, text: draft.intro }]
  draft.sections.forEach((section, i) => {
    blocks.push({
      kind: 'section',
      index: i,
      label: `Section ${i + 1} — ${section.heading}`,
      heading: section.heading,
      text: section.body,
    })
  })
  draft.faq.forEach((entry, i) => {
    blocks.push({
      kind: 'faq',
      index: i,
      label: `FAQ — ${entry.question}`,
      heading: entry.question,
      text: entry.answer,
    })
  })
  return blocks
}

/**
 * Sentence boundaries, deliberately conservative.
 *
 * A full stop between two digits is a decimal point, not the end of a
 * sentence — splitting "holds 1.5 litres" in half would hand the citation
 * check a fragment carrying a number and no marker, and fail a draft that is
 * perfectly cited. The same applies to a stop inside a marker.
 */
export function sentencesIn(text: string): string[] {
  const parts: string[] = []
  let current = ''
  const chars = [...text]

  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i]!
    current += char
    if (char !== '.' && char !== '!' && char !== '?') continue

    const previous = chars[i - 1]
    const next = chars[i + 1]
    if (char === '.' && previous !== undefined && next !== undefined && /\d/.test(previous) && /\d/.test(next)) {
      continue
    }
    // Consume any run of closing punctuation and markers that belongs to this
    // sentence rather than the next one.
    while (chars[i + 1] !== undefined && /["')\]]/.test(chars[i + 1]!)) {
      i += 1
      current += chars[i]!
    }
    if (chars[i + 1] === undefined || /\s/.test(chars[i + 1]!)) {
      parts.push(current.trim())
      current = ''
    }
  }

  if (current.trim() !== '') parts.push(current.trim())
  return parts.filter((s) => s !== '')
}

export function sentencesOf(draft: Draft): ProseSentence[] {
  const out: ProseSentence[] = []
  for (const block of blocksOf(draft)) {
    sentencesIn(block.text).forEach((text, index) => {
      out.push({ block, index, text, plain: stripMarkers(text).trim(), citedClaimIds: citedClaimIdsIn(text) })
    })
  }
  return out
}

export function wordsIn(text: string): string[] {
  return stripMarkers(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '')
}

/** Every word of the article a reader would actually read, title included. */
export function draftWordCount(draft: Draft): number {
  return wordsIn(draftPlainText(draft)).length
}

export function draftPlainText(draft: Draft): string {
  return [
    draft.title,
    draft.intro,
    ...draft.sections.flatMap((s) => [s.heading, s.body]),
    ...draft.faq.flatMap((f) => [f.question, f.answer]),
  ].join('\n\n')
}

/**
 * The article as one markdown document — what the judge is shown, and what
 * the near-duplicate comparison measures. Markers are stripped: the judge
 * grades the article a reader would get, not our bookkeeping.
 */
export function renderDraftMarkdown(draft: Draft): string {
  const parts = [`# ${draft.title}`, stripMarkers(draft.intro).trim()]
  for (const section of draft.sections) {
    parts.push(`## ${section.heading}`, stripMarkers(section.body).trim())
  }
  for (const entry of draft.faq) {
    parts.push(`### ${entry.question}`, stripMarkers(entry.answer).trim())
  }
  return parts.join('\n\n')
}

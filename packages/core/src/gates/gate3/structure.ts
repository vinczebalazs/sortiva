import type { Draft } from '../../generation/draft'
import { placeholdersIn } from '../../generation/product-refs'
import { blocksOf, stripMarkers } from './prose'

/**
 * Whether the document is well-formed at all — the cheapest checks there are,
 * and the reason they run first: a draft with a broken table should never cost
 * a model call.
 *
 * Everything here is a defect a reader would see on the published page: a
 * table whose rows do not line up, two sections with the same heading, a
 * heading level jumped over, a link that goes nowhere, a product reference
 * that will not resolve at publish time, a code block claiming to be JSON that
 * is not, markup that never closes — and our own internal vocabulary leaking
 * into the prose, which is how a merchant discovers we call their article an
 * "evidence pack".
 */

export type StructureIssueKind =
  | 'ragged_table_row'
  | 'duplicate_heading'
  | 'skipped_heading_level'
  | 'broken_link'
  | 'unresolvable_product_reference'
  | 'duplicate_product_reference'
  | 'invalid_structured_data'
  | 'unclosed_markup'
  | 'internal_metadata_leaked'

export interface StructureIssue {
  readonly kind: StructureIssueKind
  readonly location: string
  readonly detail: string
}

export interface StructureCheckResult {
  readonly passed: boolean
  readonly issues: readonly StructureIssue[]
}

/**
 * Words that only ever appear in our own machinery. A reader seeing any of
 * them is reading part of the pipeline, not part of the article.
 */
const INTERNAL_VOCABULARY = [
  'evidence pack',
  'claim plan',
  'fact sheet',
  'prompt_version',
  'rules_version',
  'gate 1',
  'gate 2',
  'gate 3',
  'information gain',
  'opportunity_id',
  'confidence: high',
  'confidence: medium',
  'confidence: low',
  'as an ai',
  'per the instructions',
]

function cellCount(row: string): number {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').length
}

function checkTables(text: string, location: string, issues: StructureIssue[]): void {
  const lines = text.split('\n')
  let width: number | null = null
  let rowNumber = 0

  for (const line of lines) {
    const isRow = line.trim().startsWith('|') && line.trim().endsWith('|') && line.includes('|')
    if (!isRow) {
      width = null
      rowNumber = 0
      continue
    }
    rowNumber += 1
    const count = cellCount(line)
    if (width === null) {
      width = count
      continue
    }
    if (count !== width) {
      issues.push({
        kind: 'ragged_table_row',
        location,
        detail: `table row ${rowNumber} has ${count} cells where the table's first row has ${width}`,
      })
    }
  }
}

function checkHeadingLevels(text: string, location: string, issues: StructureIssue[]): void {
  let previous: number | null = null
  for (const line of text.split('\n')) {
    const match = /^(#{1,6})\s+\S/.exec(line.trim())
    if (!match) continue
    const level = match[1]!.length
    if (previous !== null && level > previous + 1) {
      issues.push({
        kind: 'skipped_heading_level',
        location,
        detail: `a level-${level} heading follows a level-${previous} one, with nothing in between`,
      })
    }
    previous = level
  }
}

const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)]*)\)/g

function checkLinks(text: string, location: string, issues: StructureIssue[]): void {
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const label = match[1]!.trim()
    const href = match[2]!.trim()
    if (href === '' || label === '') {
      issues.push({ kind: 'broken_link', location, detail: `the link "${match[0]}" has no ${href === '' ? 'target' : 'text'}` })
      continue
    }
    const looksAddressable = /^https?:\/\/\S+$/i.test(href) || href.startsWith('/') || href.startsWith('#')
    if (!looksAddressable) {
      issues.push({ kind: 'broken_link', location, detail: `"${href}" is not an address a browser could follow` })
    }
  }
}

function checkStructuredData(text: string, location: string, issues: StructureIssue[]): void {
  for (const match of text.matchAll(/```json\s*([\s\S]*?)```/gi)) {
    try {
      JSON.parse(match[1]!)
    } catch {
      issues.push({ kind: 'invalid_structured_data', location, detail: 'a block marked as JSON does not parse' })
    }
  }
}

/**
 * Unclosed emphasis and code spans. Counted on the text with links and fenced
 * blocks removed, because a URL containing an asterisk or an underscore is not
 * emphasis and would otherwise report a defect that is not there.
 */
function checkInlineMarkup(text: string, location: string, issues: StructureIssue[]): void {
  const stripped = text.replace(/```[\s\S]*?```/g, '').replace(MARKDOWN_LINK, '$1')

  const bold = (stripped.match(/\*\*/g) ?? []).length
  if (bold % 2 !== 0) {
    issues.push({ kind: 'unclosed_markup', location, detail: 'bold markup (`**`) is opened and never closed' })
  }
  const code = (stripped.match(/`/g) ?? []).length
  if (code % 2 !== 0) {
    issues.push({ kind: 'unclosed_markup', location, detail: 'a code span (`` ` ``) is opened and never closed' })
  }
  const openBrackets = (stripped.match(/\[/g) ?? []).length
  const closeBrackets = (stripped.match(/\]/g) ?? []).length
  if (openBrackets !== closeBrackets) {
    issues.push({ kind: 'unclosed_markup', location, detail: 'square brackets do not pair up' })
  }
}

function checkInternalVocabulary(text: string, location: string, issues: StructureIssue[]): void {
  const lower = text.toLowerCase()
  for (const phrase of INTERNAL_VOCABULARY) {
    if (lower.includes(phrase)) {
      issues.push({
        kind: 'internal_metadata_leaked',
        location,
        detail: `"${phrase}" is our own vocabulary and does not belong in an article a merchant publishes`,
      })
    }
  }
}

export function checkStructure(draft: Draft): StructureCheckResult {
  const issues: StructureIssue[] = []
  const blocks = blocksOf(draft)

  const seenHeadings = new Map<string, string>()
  for (const block of blocks) {
    if (block.heading === null) continue
    const key = block.heading.trim().toLowerCase()
    const first = seenHeadings.get(key)
    if (first) {
      issues.push({
        kind: 'duplicate_heading',
        location: block.label,
        detail: `"${block.heading}" is already the heading of ${first}`,
      })
    } else {
      seenHeadings.set(key, block.label)
    }
  }

  for (const block of blocks) {
    // Markers are the pipeline's, not the reader's: they would register as
    // unpaired brackets in every sentence that cites anything.
    const text = stripMarkers(block.text)
    checkTables(text, block.label, issues)
    checkHeadingLevels(text, block.label, issues)
    checkLinks(text, block.label, issues)
    checkStructuredData(text, block.label, issues)
    checkInlineMarkup(text, block.label, issues)
    checkInternalVocabulary(text, block.label, issues)
    if (block.heading) checkInternalVocabulary(block.heading, block.label, issues)
  }
  checkInternalVocabulary(draft.title, 'Title', issues)
  checkInternalVocabulary(draft.metaDescription, 'Meta description', issues)

  // Product references: every `{{pN}}` in the prose must have a declared
  // mention behind it, every declared mention must appear somewhere, and no id
  // may be declared twice — a duplicate is two rows competing to fill one
  // placeholder at publish time.
  const declared = new Map<string, number>()
  for (const mention of draft.productMentions) {
    declared.set(mention.id, (declared.get(mention.id) ?? 0) + 1)
  }
  for (const [id, count] of declared) {
    if (count > 1) {
      issues.push({
        kind: 'duplicate_product_reference',
        location: 'Product references',
        detail: `"${id}" is declared ${count} times, so nothing decides which row fills it`,
      })
    }
  }

  const used = new Set<string>()
  for (const block of blocks) {
    for (const id of placeholdersIn(block.text)) {
      used.add(id)
      if (!declared.has(id)) {
        issues.push({
          kind: 'unresolvable_product_reference',
          location: block.label,
          detail: `{{${id}}} names no declared product, so it would publish as a hole`,
        })
      }
    }
  }
  for (const id of declared.keys()) {
    if (!used.has(id)) {
      issues.push({
        kind: 'unresolvable_product_reference',
        location: 'Product references',
        detail: `"${id}" is declared but never placed in the body`,
      })
    }
  }

  return { passed: issues.length === 0, issues }
}

import type { GatesConfig, GenerationConfig } from '@sortiva/rules'
import type { ClaimPlan } from '../../generation/claims'
import type { Draft } from '../../generation/draft'
import type { EvidencePack } from '../../generation/evidence-pack'
import { meetsInternalLinkMinimum, type InternalLinkTarget } from '../../generation/internal-links'
import type { LengthTarget } from '../../generation/length'
import { containsCurrencyFigure, currencyFiguresIn } from '../../generation/product-refs'
import { checkCitations } from './citations'
import { checkNearDuplicate, type ComparisonText } from './duplication'
import { blocksOf, draftPlainText, draftWordCount, stripMarkers, wordsIn } from './prose'
import { checkStructure } from './structure'
import { checkAssertionStrength } from './strength'

/**
 * Gate 3's free half: every check that costs nothing, run before anything that
 * costs money. The ordering is the substance — a draft with a broken table, a
 * missing citation or a contradiction should never buy a model call.
 *
 * The checks are grouped so a failure names the thing that failed rather than
 * "the draft was rejected": structure, citations, assertion strength, the
 * volatile-value rule, length, links, stuffing and near-duplication each carry
 * their own issue list and their own user-facing reason.
 */

export type LintCategory =
  | 'structure'
  | 'citations'
  | 'assertion_strength'
  | 'volatile_values'
  | 'length'
  | 'internal_links'
  | 'keyword_stuffing'
  | 'near_duplicate'

export interface LintIssue {
  readonly category: LintCategory
  readonly kind: string
  readonly location: string
  readonly detail: string
  /** The offending sentence, where the check works at sentence level — so a repair instruction can quote it back. */
  readonly sentence?: string
}

export interface LintResult {
  readonly passed: boolean
  readonly issues: readonly LintIssue[]
  /** The first category that failed — what the merchant's reason card names. */
  readonly failedCategory: LintCategory | null
  readonly wordCount: number
  readonly keywordDensity: number
  readonly highestSimilarity: number
}

export interface LintInput {
  readonly draft: Draft
  readonly plan: ClaimPlan
  readonly pack: EvidencePack
  readonly targetKeyword: string
  readonly length: LengthTarget
  readonly internalLinks: readonly InternalLinkTarget[]
  /** The store's own earlier articles and the pages currently ranking, to compare against. */
  readonly comparisons: readonly ComparisonText[]
  readonly gates: GatesConfig
  readonly generation: GenerationConfig
}

/**
 * How much of the article is the target keyword. Counted as a phrase over the
 * article's own words, so a two-word keyword repeated ten times in a
 * thousand-word article reads as 2%, not 1%.
 */
export function keywordDensity(text: string, keyword: string): number {
  const words = wordsIn(text)
  const keywordWords = wordsIn(keyword)
  if (words.length === 0 || keywordWords.length === 0) return 0

  let occurrences = 0
  for (let i = 0; i + keywordWords.length <= words.length; i += 1) {
    if (keywordWords.every((word, offset) => words[i + offset] === word)) occurrences += 1
  }
  return (occurrences * keywordWords.length) / words.length
}

function linkedUrlsIn(draft: Draft): string[] {
  const urls: string[] = []
  for (const block of blocksOf(draft)) {
    for (const match of stripMarkers(block.text).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      urls.push(match[1]!.trim())
    }
  }
  return urls
}

export function runLints(input: LintInput): LintResult {
  const issues: LintIssue[] = []
  const plain = draftPlainText(input.draft)
  const wordCount = draftWordCount(input.draft)
  const density = keywordDensity(plain, input.targetKeyword)

  const structure = checkStructure(input.draft)
  for (const issue of structure.issues) {
    issues.push({ category: 'structure', kind: issue.kind, location: issue.location, detail: issue.detail })
  }

  const citations = checkCitations(input.draft, input.plan, input.pack)
  for (const issue of citations.issues) {
    issues.push({
      category: 'citations',
      kind: issue.kind,
      location: issue.location,
      detail: issue.detail,
      sentence: issue.sentence,
    })
  }

  const strength = checkAssertionStrength(input.draft, input.plan)
  for (const issue of strength.issues) {
    issues.push({
      category: 'assertion_strength',
      kind: issue.kind,
      location: issue.location,
      detail: issue.detail,
      sentence: issue.sentence,
    })
  }

  // A price written as text is a sentence that will be wrong by next week —
  // the body carries a product reference instead, resolved at publish.
  for (const block of blocksOf(input.draft)) {
    const text = stripMarkers(block.text)
    if (containsCurrencyFigure(text)) {
      issues.push({
        category: 'volatile_values',
        kind: 'literal_currency_figure',
        location: block.label,
        detail: `${currencyFiguresIn(text).join(', ')} is written as text where a product reference belongs`,
      })
    }
  }

  const floor = Math.round(input.length.minWords * input.gates.draft_lints.length_target_floor_ratio)
  if (wordCount < floor) {
    issues.push({
      category: 'length',
      kind: 'below_length_floor',
      location: 'The article as a whole',
      detail: `${wordCount} words against a floor of ${floor} for this topic — the pages ranking for it go deeper`,
    })
  }

  if (!meetsInternalLinkMinimum(linkedUrlsIn(input.draft), input.internalLinks, input.generation.internal_links)) {
    issues.push({
      category: 'internal_links',
      kind: 'required_link_missing',
      location: 'The article as a whole',
      detail: `it does not link to ${input.internalLinks.map((l) => l.url).join(', ') || 'the pages it was required to'}`,
    })
  }

  if (density > input.gates.draft_lints.keyword_density_max) {
    issues.push({
      category: 'keyword_stuffing',
      kind: 'keyword_density_too_high',
      location: 'The article as a whole',
      detail: `"${input.targetKeyword}" is ${Math.round(density * 1000) / 10}% of the article's words`,
    })
  }

  const duplication = checkNearDuplicate(plain, input.comparisons, input.gates.draft_lints)
  for (const issue of duplication.issues) {
    issues.push({ category: 'near_duplicate', kind: issue.kind, location: issue.location, detail: issue.detail })
  }

  return {
    passed: issues.length === 0,
    issues,
    failedCategory: issues[0]?.category ?? null,
    wordCount,
    keywordDensity: density,
    highestSimilarity: duplication.highestSimilarity,
  }
}

import type { GatesConfig } from '@sortiva/rules'
import { similarityAgainst } from '../gates/gate3/duplication'
import { wordsIn } from '../gates/gate3/prose'
import { packFactAddresses, packLinkAddresses, type OptimizeEvidencePack } from './pack'
import type { OptimizeRecommendation } from './recommendation'

/**
 * The free checks, run on every recommendation before it costs anything to
 * grade and long before a merchant sees it.
 *
 * They exist because the expensive check cannot catch these. A grader reads
 * for quality; it does not know which addresses were in the pack, what is
 * already on the page, or which of the store's pages exist. Each of these five
 * is a fact about our own data, so each is decided here, for free, against the
 * pack — and a failure is repaired by asking once more with the failures
 * attached, not by softening the check.
 */

export type OptimizeLintCheck =
  | 'grounding'
  | 'duplicate_paragraph'
  | 'link_target_missing'
  | 'length'
  | 'keyword_stuffing'

export interface OptimizeLintIssue {
  readonly check: OptimizeLintCheck
  /** Where in the recommendation, in words the model can act on: `sections[2]`, `title_tag`. */
  readonly location: string
  /** One sentence saying what is wrong. Sent back verbatim on the single re-ask. */
  readonly detail: string
}

export interface OptimizeLintResult {
  readonly passed: boolean
  readonly issues: readonly OptimizeLintIssue[]
}

/** The page's own paragraphs, as the duplication check compares against them. */
function paragraphsOf(bodyText: string): string[] {
  return bodyText
    .split(/\n\s*\n|\r\n\s*\r\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => wordsIn(paragraph).length > 0)
}

/** How much of the suggested passage already appears in one of the page's own paragraphs. */
function highestOverlap(copy: string, paragraphs: readonly string[], shingleWords: number): number {
  let highest = 0
  for (const paragraph of paragraphs) {
    const similarity = similarityAgainst(copy, paragraph, shingleWords)
    if (similarity > highest) highest = similarity
  }
  return highest
}

/** How often a run of words appears inside another run. */
function runOccurrences(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || haystack.length < needle.length) return 0
  let found = 0
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    let matches = true
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        matches = false
        break
      }
    }
    if (matches) found += 1
  }
  return found
}

export function lintRecommendation(
  recommendation: OptimizeRecommendation,
  input: {
    readonly pack: OptimizeEvidencePack
    readonly config: GatesConfig['optimize_recommendation']
  },
): OptimizeLintResult {
  const { pack, config } = input
  const issues: OptimizeLintIssue[] = []
  const addresses = packFactAddresses(pack)
  const linkTargets = packLinkAddresses(pack)
  const paragraphs = paragraphsOf(pack.page.bodyText)

  // ── Grounding ──────────────────────────────────────────────────────────────
  // An address that is not in the pack is not evidence: either the model
  // invented it or it cited something it was never shown. Both mean the
  // passage resting on it cannot be traced, which is the one thing a merchant
  // pasting it onto their own page has to be able to rely on.
  const citing: { location: string; facts: readonly string[] }[] = [
    ...recommendation.sections.map((section, index) => ({
      location: `sections[${index}] "${section.heading}"`,
      facts: section.facts_used,
    })),
    ...recommendation.faq.map((entry, index) => ({
      location: `faq[${index}] "${entry.q}"`,
      facts: entry.facts_used,
    })),
  ]

  for (const { location, facts } of citing) {
    if (facts.length === 0) {
      issues.push({
        check: 'grounding',
        location,
        detail: 'cites no evidence at all; every suggested passage must name the addresses it rests on',
      })
      continue
    }
    for (const address of facts) {
      if (addresses.has(address)) continue
      issues.push({
        check: 'grounding',
        location,
        detail: `cites "${address}", which was not among the addresses you were given`,
      })
    }
  }

  // ── Duplicate paragraph ────────────────────────────────────────────────────
  // A suggestion that restates a paragraph already on the page is work for the
  // merchant with nothing at the end of it.
  const copyBlocks: { location: string; text: string }[] = [
    ...recommendation.sections.map((section, index) => ({
      location: `sections[${index}] "${section.heading}"`,
      text: section.suggested_copy,
    })),
    ...recommendation.faq.map((entry, index) => ({ location: `faq[${index}] "${entry.q}"`, text: entry.a })),
  ]

  for (const block of copyBlocks) {
    const overlap = highestOverlap(block.text, paragraphs, config.duplicate_paragraph_shingle_words)
    if (overlap <= config.duplicate_paragraph_similarity_max) continue
    issues.push({
      check: 'duplicate_paragraph',
      location: block.location,
      detail: `${Math.round(overlap * 100)}% of this passage already appears in a paragraph on the page; suggest what is missing instead`,
    })
  }

  // ── Link targets ───────────────────────────────────────────────────────────
  // A link to a page that does not exist is a 404 the merchant would publish
  // in our name.
  const links = [
    ...recommendation.internal_links.add_from.map((link, index) => ({
      location: `internal_links.add_from[${index}]`,
      url: link.url,
    })),
    ...recommendation.internal_links.add_to.map((link, index) => ({
      location: `internal_links.add_to[${index}]`,
      url: link.url,
    })),
  ]

  for (const link of links) {
    if (linkTargets.has(link.url)) continue
    issues.push({
      check: 'link_target_missing',
      location: link.location,
      detail: `"${link.url}" is not one of this store's pages; use only the addresses you were given`,
    })
  }

  // ── Lengths ────────────────────────────────────────────────────────────────
  // Past these, the search result truncates and the merchant loses the end of
  // the sentence they were sold on.
  const title = recommendation.title_tag.suggested
  if ([...title].length > config.title_max_chars) {
    issues.push({
      check: 'length',
      location: 'title_tag',
      detail: `the suggested title is ${[...title].length} characters; it must be ${config.title_max_chars} or fewer`,
    })
  }
  const meta = recommendation.meta_description.suggested
  if ([...meta].length > config.meta_description_max_chars) {
    issues.push({
      check: 'length',
      location: 'meta_description',
      detail: `the suggested description is ${[...meta].length} characters; it must be ${config.meta_description_max_chars} or fewer`,
    })
  }

  // ── Stuffing ───────────────────────────────────────────────────────────────
  // Measured across all the suggested prose together, because a single mention
  // in one short passage is a large share of that passage and no share of the
  // recommendation. The title and the description are deliberately outside
  // this: naming the search in them is what they are for, and counting them
  // would fail every correct suggestion we make.
  const allCopy = [
    ...recommendation.sections.map((s) => `${s.heading} ${s.suggested_copy}`),
    ...recommendation.faq.map((f) => `${f.q} ${f.a}`),
    ...recommendation.headings.map((h) => h.text),
  ].join(' ')
  const copyWords = wordsIn(allCopy)
  const queryWords = wordsIn(pack.targetQuery)
  if (copyWords.length > 0 && queryWords.length > 0) {
    const density = (runOccurrences(copyWords, queryWords) * queryWords.length) / copyWords.length
    if (density > config.keyword_density_max) {
      issues.push({
        check: 'keyword_stuffing',
        location: 'suggested copy',
        detail: `"${pack.targetQuery}" takes up ${Math.round(density * 100)}% of the suggested copy; name it once where it belongs and write the rest in the store's own words`,
      })
    }
  }

  return { passed: issues.length === 0, issues }
}

/** The failures as the one re-ask sends them back: where, and what is wrong. */
export function lintMessages(result: OptimizeLintResult): string[] {
  return result.issues.map((issue) => `${issue.location}: ${issue.detail}`)
}

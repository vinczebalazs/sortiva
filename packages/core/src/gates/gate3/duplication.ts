import type { GatesConfig } from '@sortiva/rules'
import { wordsIn } from './prose'

/**
 * Near-duplicate detection, main §8.4 — "the classic at-scale failure where
 * article #40 sounds like article #12", and the same comparison against the
 * pages already ranking, because rewriting the SERP back at itself is the
 * other way to publish nothing new.
 *
 * Measured as the share of word runs two texts have in common. Runs rather
 * than words because vocabulary overlap is inevitable — two articles about
 * the same product family share every noun in it — while a long run of words
 * in the same order is reuse.
 */

export interface ComparisonText {
  /** What the merchant would recognise: another article's title, or a ranking page's URL. */
  readonly label: string
  readonly kind: 'own_article' | 'ranking_page'
  readonly text: string
}

export interface DuplicationIssue {
  readonly kind: 'near_duplicate'
  readonly location: string
  readonly detail: string
  readonly similarity: number
}

export interface DuplicationCheckResult {
  readonly passed: boolean
  readonly issues: readonly DuplicationIssue[]
  /** The closest match found, whether or not it crossed the line — recorded on the gate decision. */
  readonly highestSimilarity: number
}

export function shingles(text: string, size: number): Set<string> {
  const words = wordsIn(text)
  const out = new Set<string>()
  if (words.length < size) {
    if (words.length > 0) out.add(words.join(' '))
    return out
  }
  for (let i = 0; i + size <= words.length; i += 1) {
    out.add(words.slice(i, i + size).join(' '))
  }
  return out
}

/**
 * Overlap as a share of the *draft's* runs, not of the union. A short draft
 * lifted wholesale from a long competitor page shares few of the union's runs
 * and nearly all of its own — which is exactly the case that must fail.
 */
export function similarityAgainst(draftText: string, otherText: string, size: number): number {
  const a = shingles(draftText, size)
  const b = shingles(otherText, size)
  if (a.size === 0) return 0
  let shared = 0
  for (const run of a) if (b.has(run)) shared += 1
  return shared / a.size
}

export function checkNearDuplicate(
  draftText: string,
  comparisons: readonly ComparisonText[],
  config: GatesConfig['draft_lints'],
): DuplicationCheckResult {
  const issues: DuplicationIssue[] = []
  let highest = 0

  for (const comparison of comparisons) {
    const similarity = similarityAgainst(draftText, comparison.text, config.near_duplicate_shingle_words)
    if (similarity > highest) highest = similarity
    if (similarity > config.near_duplicate_similarity_max) {
      issues.push({
        kind: 'near_duplicate',
        location: comparison.kind === 'own_article' ? 'Against your other articles' : 'Against the pages already ranking',
        similarity,
        detail: `${Math.round(similarity * 100)}% of this draft's phrasing already appears in ${comparison.label}`,
      })
    }
  }

  return { passed: issues.length === 0, issues, highestSimilarity: highest }
}

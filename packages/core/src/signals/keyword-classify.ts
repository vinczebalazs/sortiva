import type { IntentClass } from '../contracts/opportunities'

/**
 * Turning a keyword's own words into the two things the catalogue/market
 * signals need and nothing in this codebase derives yet: what kind of article
 * it wants, and which product families it is about.
 *
 * **Why this exists at all, stated plainly because it is a real gap, not a
 * convenience.** `keywords` (schema wave 2, T2.6) carries no intent or family
 * column, and nothing anywhere — checked before writing this — derives an
 * `IntentClass` from free text (the same fact `T4.2`'s own decision journal
 * records for the sibling manual-add problem, 2026-09-03). Main §6.6 says a
 * seed keyword is generated *from* a specific product family's axes, so the
 * link exists the moment DataForSEO enriches it — and is then lost, because
 * nowhere persists it. Fixing that at the source needs either a migration
 * (outside this card, and outside a schema-wave card) or touching `T2.6`'s own
 * ingestion pipeline (outside Lane C's directories). Neither is available to
 * this card, and four of the nine P0 detectors — `uncovered_commercial_query`,
 * `competitor_coverage_gap`, `product_family_coverage_gap`,
 * `catalog_richness_gap` — cannot run at all without *some* answer, so the
 * weekly scan itself cannot exist without one.
 *
 * **What this is not.** Main §7.5 step 1 requires signal detection to run with
 * "no LLM, no billable calls" — so an LLM call per keyword, the accurate
 * answer the founder chose for the one-off manual-add case, is not available
 * here at all; the spec forbids it outright for a step that runs over every
 * confirmed keyword on every scan. This is therefore a **deterministic
 * heuristic**, not a classifier — pattern-matching on the keyword's own words,
 * free and instant, always inferior to the lineage `T2.6` already had and threw
 * away. Flagged for a founder/integrator decision: persisting the real
 * origin-family and a proper intent classification at keyword *enrichment*
 * time (already a billable, one-time step, unlike detection) would be strictly
 * better than this and is a schema-wave-sized fix this card cannot make.
 * See DECISIONS 2026-09-03 T3.7.
 */

/** Checked in this order — comparison and buying-guide phrasing both often contain "how", so order is the whole rule. */
const COMPARISON_PATTERN = /\b(vs\.?|versus|compare[d]?(?:\s+to|\s+with)?)\b/
const BUYING_GUIDE_PATTERN = /\b(best|top\s?\d*|guide|buying guide|which\b.*\bshould)\b/
const HOW_TO_PATTERN = /\bhow\s+to\b/

export function classifyKeywordIntent(term: string): IntentClass {
  const t = term.toLowerCase()
  if (COMPARISON_PATTERN.test(t)) return 'comparison'
  if (BUYING_GUIDE_PATTERN.test(t)) return 'buying_guide'
  if (HOW_TO_PATTERN.test(t)) return 'how_to'
  return 'informational'
}

/** Family/axis words too short or too common to mean anything on their own. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'best', 'top', 'a', 'an', 'of', 'to', 'in', 'on', 'or', 'vs',
])

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word)),
  )
}

export interface FamilyMappingCandidate {
  readonly id: string
  readonly name: string
  readonly differentiationAxes: readonly string[]
}

/**
 * Which of the store's families a keyword is plausibly about: the family's
 * name or one of its differentiation axes shares a significant word with the
 * keyword. Free-text overlap, same shape and same honesty as `T3.5`'s own
 * word-containment choice for query clustering (DECISIONS 2026-09-02 T3.5) —
 * it can miss a real match (costs a signal), it cannot invent one out of
 * nothing shared (never fabricates a family this keyword has nothing to do
 * with).
 */
export function mapKeywordToFamilies(
  term: string,
  families: readonly FamilyMappingCandidate[],
): readonly string[] {
  const keywordWords = significantWords(term)
  if (keywordWords.size === 0) return []

  const matches: string[] = []
  for (const family of families) {
    const familyWords = significantWords([family.name, ...family.differentiationAxes].join(' '))
    const overlaps = [...familyWords].some((word) => keywordWords.has(word))
    if (overlaps) matches.push(family.id)
  }
  return matches.sort()
}

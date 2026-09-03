import type { SignalsConfig } from '@sortiva/rules'
import type { EvidenceFact, IntentClass } from '../contracts/opportunities'
import { INVENTORY_SOURCE, facts } from './types'

/**
 * A range the store actually makes its money from, with nothing written about
 * it that search can find.
 *
 * This is the "ecommerce context first" principle as a signal. The rest of the
 * engine reasons from what Google shows and what competitors do; this one
 * reasons from the shop's own till. A range earning a real share of the last
 * quarter's revenue, or sitting among the best sellers, deserves coverage
 * before anything the store merely stocks — and if there is demand for it and
 * nothing of ours answers that demand, that is the clearest kind of gap there
 * is.
 *
 * "Nothing written about it" is deliberately strict about what counts. A
 * collection page that exists but has never been shown for anything is not
 * coverage; it is a page with a list of products on it.
 */

/** One thing of ours already pointing at this range. */
export interface MappedContent {
  readonly url: string
  /** Ours means an article this product published; the store's own pages are the other kind. */
  readonly kind: 'ours' | 'store'
  /** Whether search has ever shown it — the difference between a page and coverage. */
  readonly ranks: boolean
}

export interface FamilyCoverageCandidate {
  readonly familyId: string
  readonly familyName: string
  /** Among the store's best sellers, as the catalogue reports them. */
  readonly isTopSeller: boolean
  /** This range's share of the trailing revenue window, 0–1. */
  readonly revenueShare: number
  readonly mappedContent: readonly MappedContent[]
  /** How many searches mapped to this range clear the demand floor. */
  readonly keywordCandidatesClearingFloor: number
  /**
   * What kind of article a whole-range gap wants. Unlike every other signal
   * that proposes new coverage, this one has no single keyword to read an
   * intent off — it is a gap in the range itself, not in one search — so the
   * caller decides and supplies it rather than this module guessing at free
   * text. `DbTopicScheduler` needs this via the `intent_class` evidence fact
   * below (DECISIONS 2026-09-03 T4.2) or it cannot place the resulting topic
   * at all.
   */
  readonly intentClass: IntentClass
}

export interface FamilyCoverageGapSignal {
  readonly signalType: 'product_family_coverage_gap'
  readonly familyId: string
  readonly familyName: string
  readonly isTopSeller: boolean
  readonly revenueShare: number
  readonly keywordCandidatesClearingFloor: number
  /** Pages of ours that mention the range but have never been shown for anything. */
  readonly unrankedPages: readonly string[]
  readonly evidence: readonly EvidenceFact[]
}

export interface FamilyCoverageInput {
  readonly candidates: readonly FamilyCoverageCandidate[]
  readonly config: SignalsConfig['product_family_coverage_gap']
  readonly fetchedAt: string
}

export function detectFamilyCoverageGaps(
  input: FamilyCoverageInput,
): readonly FamilyCoverageGapSignal[] {
  const { config } = input
  const out: FamilyCoverageGapSignal[] = []

  for (const candidate of input.candidates) {
    const mattersToTheBusiness =
      candidate.isTopSeller || candidate.revenueShare >= config.revenue_share_min
    if (!mattersToTheBusiness) continue

    const covered = candidate.mappedContent.some((item) => item.kind === 'ours' || item.ranks)
    if (covered) continue

    if (candidate.keywordCandidatesClearingFloor < config.keyword_candidates_min) continue

    out.push({
      signalType: 'product_family_coverage_gap',
      familyId: candidate.familyId,
      familyName: candidate.familyName,
      isTopSeller: candidate.isTopSeller,
      revenueShare: candidate.revenueShare,
      keywordCandidatesClearingFloor: candidate.keywordCandidatesClearingFloor,
      unrankedPages: candidate.mappedContent.map((item) => item.url).sort(),
      evidence: facts(input.fetchedAt, [
        { key: 'family', value: candidate.familyName, source: INVENTORY_SOURCE },
        { key: 'top_seller', value: candidate.isTopSeller ? 'yes' : 'no', source: 'catalog' },
        {
          key: 'revenue_share',
          value: candidate.revenueShare,
          source: 'catalog',
          window: `${config.revenue_window_days}d`,
        },
        { key: 'mapped_content', value: candidate.mappedContent.length, source: INVENTORY_SOURCE },
        {
          key: 'keyword_candidates',
          value: candidate.keywordCandidatesClearingFloor,
          source: 'dataforseo',
        },
        // Same `intent_class`/`family_id` convention as the other two
        // new-coverage signals (DECISIONS 2026-09-03 T3.7) — a single
        // `family_id` fact is enough here, since the family *is* the entity.
        { key: 'intent_class', value: candidate.intentClass, source: INVENTORY_SOURCE },
        { key: 'family_id', value: candidate.familyId, source: INVENTORY_SOURCE },
      ]),
    })
  }

  return out
}

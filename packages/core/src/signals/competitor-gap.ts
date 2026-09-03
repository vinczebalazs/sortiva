import type { SignalsConfig } from '@sortiva/rules'
import type { EvidenceFact } from '../contracts/opportunities'
import { INVENTORY_SOURCE, facts, normalisePageUrl } from './types'
import type { KeywordCandidate } from './candidates'

/**
 * Shops the merchant competes with are being found for something the merchant
 * sells, and the merchant is not.
 *
 * The evidence is somebody else's success, which is what makes this signal
 * worth acting on: the demand is proven, the subject is one a shop like this
 * can rank for, and we are simply absent. Two competitors are required rather
 * than one, because a single shop doing something unusual is that shop's
 * strategy, not a gap in ours.
 *
 * Where the store does hold a position for the search, but a middling one, that
 * position and the page holding it travel in the evidence — because a page that
 * already ranks in that band is a better target than a new one, and the
 * decision that follows needs to know it exists.
 */

export interface CompetitorRanking {
  /** The competitor's registrable domain, already normalised. */
  readonly domain: string
  readonly position: number
  readonly url: string
}

export interface CompetitorGapCandidate extends KeywordCandidate {
  /** Where each business competitor sits for this search. At most five competitors exist per account. */
  readonly competitorRankings: readonly CompetitorRanking[]
  /** Our own best position for this search, from Search Console or the vendor proxy. Null when we hold none. */
  readonly ourPosition: number | null
  readonly ourUrl: string | null
}

export interface CompetitorGapSignal {
  readonly signalType: 'competitor_coverage_gap'
  readonly keyword: string
  readonly monthlySearchVolume: number | null
  readonly familyIds: readonly string[]
  /** The competitor domains ranking well for it, best position first. */
  readonly competitorsRanking: readonly CompetitorRanking[]
  readonly ourPosition: number | null
  /**
   * A page of ours already ranking in the middling band, where one exists.
   * Improving it is the cheaper route than a new page, and the evidence has to
   * carry it for that choice to be available later.
   */
  readonly ourRankingUrl: string | null
  readonly evidence: readonly EvidenceFact[]
}

export interface CompetitorGapInput {
  readonly candidates: readonly CompetitorGapCandidate[]
  readonly config: SignalsConfig['competitor_coverage_gap']
  readonly fetchedAt: string
}

export function detectCompetitorCoverageGaps(
  input: CompetitorGapInput,
): readonly CompetitorGapSignal[] {
  const { config } = input
  const out: CompetitorGapSignal[] = []

  for (const candidate of input.candidates) {
    // A search that maps to nothing the store sells is not a gap in our
    // coverage; it is somebody else's business.
    if (candidate.familyIds.length === 0) continue

    const ranking = [...candidate.competitorRankings]
      .filter((row) => row.position <= config.competitor_position_max)
      .sort((a, b) => a.position - b.position || a.domain.localeCompare(b.domain))

    const distinctDomains = new Set(ranking.map((row) => row.domain))
    if (distinctDomains.size < config.competitors_ranking_min) continue

    const weHold = candidate.ourPosition
    if (weHold !== null && weHold <= config.our_absent_position_max) continue

    const inOptimizeBand =
      weHold !== null &&
      weHold >= config.optimize_position_min &&
      weHold <= config.optimize_position_max

    out.push({
      signalType: 'competitor_coverage_gap',
      keyword: candidate.keyword,
      monthlySearchVolume: candidate.monthlySearchVolume,
      familyIds: candidate.familyIds,
      competitorsRanking: ranking,
      ourPosition: weHold,
      ourRankingUrl: inOptimizeBand && candidate.ourUrl ? normalisePageUrl(candidate.ourUrl) : null,
      evidence: facts(input.fetchedAt, [
        { key: 'keyword', value: candidate.keyword, source: INVENTORY_SOURCE },
        { key: 'monthly_search_volume', value: candidate.monthlySearchVolume ?? 'unknown', source: 'dataforseo' },
        { key: 'competitors_ranking', value: distinctDomains.size, source: 'dataforseo' },
        { key: 'best_competitor_position', value: ranking[0]!.position, source: 'dataforseo' },
        { key: 'best_competitor_domain', value: ranking[0]!.domain, source: 'dataforseo' },
        { key: 'our_position', value: weHold ?? 'absent', source: 'dataforseo' },
        ...(inOptimizeBand && candidate.ourUrl
          ? [{ key: 'our_ranking_url', value: normalisePageUrl(candidate.ourUrl), source: INVENTORY_SOURCE }]
          : []),
        // The `intent_class` convention `DbTopicScheduler` already reads
        // (DECISIONS 2026-09-03 T4.2) — the data was already on the candidate
        // (`KeywordCandidate.intentClass`), it was simply never stamped into
        // this signal's own evidence. One `family_id` fact per mapped family:
        // `EvidenceFact.value` cannot hold an array, so a repeated key is the
        // encoding, same convention this card establishes in
        // `uncovered-query.ts`/`family-coverage.ts`. See DECISIONS 2026-09-03 T3.7.
        { key: 'intent_class', value: candidate.intentClass, source: INVENTORY_SOURCE },
        ...candidate.familyIds.map((familyId) => ({
          key: 'family_id',
          value: familyId,
          source: INVENTORY_SOURCE,
        })),
      ]),
    })
  }

  return out
}

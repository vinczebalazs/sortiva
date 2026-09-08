import type { SignalsConfig } from '@sortiva/rules'
import type { EvidenceFact } from '../contracts/opportunities'
import { INVENTORY_SOURCE, facts, normalisePageUrl } from './types'
import type { ExistingCoverage, KeywordCandidate } from './candidates'

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
 *
 * A search-result position is not the only way the store can already have a
 * page for a subject, and it is the least reliable one: a page can serve the
 * subject perfectly and rank nowhere at all. So every candidate arrives with
 * the existing-target check's answer attached, and that answer — not the
 * ranking — is what decides whether a new page is on the table.
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
  /** What the existing-target check said about this search. Assembled for every candidate, never optional. */
  readonly existingTarget: ExistingCoverage
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
  /**
   * What kind of page `ourRankingUrl` is, where we know. Null for a page found
   * only in a search-result snapshot: the snapshot gives an address and a
   * position and says nothing about what the page is.
   */
  readonly ourRankingPageType: string | null
  /**
   * The check's answer, carried through so the step that chooses an action can
   * see both halves: the page the store already has, and the permission slip
   * that only exists when there is no such page.
   */
  readonly existingTarget: ExistingCoverage
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

    // Two independent ways the store can already own this subject. The band is
    // about a page that ranks middlingly and could be pushed up; the check is
    // about a page that covers the subject whether or not search has noticed
    // it. Either one names a page of the merchant's to improve, and a page
    // named here is a page the recommendation is about instead of a new one.
    const existing = candidate.existingTarget
    const strongMatch = existing.strength === 'strong' ? existing : null
    const fromBand = inOptimizeBand && candidate.ourUrl ? normalisePageUrl(candidate.ourUrl) : null
    const ourRankingUrl = fromBand ?? strongMatch?.url ?? null
    const ourRankingPageType = fromBand ? null : (strongMatch?.pageType ?? null)
    const ourPosition = weHold ?? strongMatch?.position ?? null

    out.push({
      signalType: 'competitor_coverage_gap',
      keyword: candidate.keyword,
      monthlySearchVolume: candidate.monthlySearchVolume,
      familyIds: candidate.familyIds,
      competitorsRanking: ranking,
      ourPosition,
      ourRankingUrl,
      ourRankingPageType,
      existingTarget: existing,
      evidence: facts(input.fetchedAt, [
        { key: 'keyword', value: candidate.keyword, source: INVENTORY_SOURCE },
        { key: 'monthly_search_volume', value: candidate.monthlySearchVolume ?? 'unknown', source: 'dataforseo' },
        { key: 'competitors_ranking', value: distinctDomains.size, source: 'dataforseo' },
        { key: 'best_competitor_position', value: ranking[0]!.position, source: 'dataforseo' },
        { key: 'best_competitor_domain', value: ranking[0]!.domain, source: 'dataforseo' },
        { key: 'our_position', value: ourPosition ?? 'absent', source: 'dataforseo' },
        ...(ourRankingUrl ? [{ key: 'our_ranking_url', value: ourRankingUrl, source: INVENTORY_SOURCE }] : []),
        { key: 'existing_target_match', value: existing.strength, source: INVENTORY_SOURCE },
        ...(existing.url ? [{ key: 'existing_target_url', value: existing.url, source: INVENTORY_SOURCE }] : []),
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

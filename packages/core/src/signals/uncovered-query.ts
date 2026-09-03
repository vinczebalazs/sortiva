import type { GatesConfig, SignalsConfig } from '@sortiva/rules'
import type { EvidenceFact, IntentClass } from '../contracts/opportunities'
import { INVENTORY_SOURCE, facts } from './types'
import { clearsDemandFloor, isCommercialIntent, type ExistingCoverage, type KeywordCandidate } from './candidates'

/**
 * People are searching for something this store sells, and the store has
 * nothing that answers them.
 *
 * Four things all have to be true, and each one removes a different way of
 * being wrong. Enough people search for it, or the article is written for
 * nobody. The search is one a shop can serve — someone deciding what to buy,
 * not someone looking up a definition. The store actually sells into it, and we
 * know enough about those products to write honestly. And nothing the store
 * already publishes serves the search, which is the check that stops us adding
 * a second page to compete with the merchant's own.
 *
 * A search where a page of ours exists but is too weak to take the work over
 * still counts as uncovered: the new page goes ahead and links back to the old
 * one, so the two support each other instead of splitting the search.
 */

export interface UncoveredQuerySignal {
  readonly signalType: 'uncovered_commercial_query'
  readonly keyword: string
  readonly intentClass: IntentClass
  readonly monthlySearchVolume: number | null
  /** Families with enough substance behind them to write from. */
  readonly familyIds: readonly string[]
  readonly source: KeywordCandidate['source']
  /**
   * A page of ours the new one has to link to, where the check found one too
   * weak to take the work over. Null when the store has nothing at all.
   */
  readonly weakExistingTarget: string | null
  readonly evidence: readonly EvidenceFact[]
}

export interface UncoveredQueryInput {
  readonly candidates: readonly KeywordCandidate[]
  /** What the existing-target check found, keyed by keyword. A keyword absent from the map was not checked. */
  readonly coverage: ReadonlyMap<string, ExistingCoverage>
  /** Families whose products state enough for us to write from, by family id. */
  readonly familiesWithSubstance: ReadonlySet<string>
  readonly config: SignalsConfig['uncovered_commercial_query']
  readonly gates: Pick<GatesConfig, 'demand_floor'>
  readonly fetchedAt: string
}

/** A search we never ran the check for is not a covered search, it is an unanswered question. */
export class UncheckedCandidateError extends Error {
  constructor(keyword: string) {
    super(
      `No existing-target result for "${keyword}". Every candidate must be checked against the ` +
        'pages the store already has before it can be called uncovered.',
    )
    this.name = 'UncheckedCandidateError'
  }
}

export function detectUncoveredCommercialQueries(
  input: UncoveredQueryInput,
): readonly UncoveredQuerySignal[] {
  const out: UncoveredQuerySignal[] = []

  for (const candidate of input.candidates) {
    if (!isCommercialIntent(candidate.intentClass)) continue
    if (!clearsDemandFloor(candidate, input.gates.demand_floor)) continue

    const backed = candidate.familyIds.filter((id) => input.familiesWithSubstance.has(id))
    if (backed.length < input.config.mapped_families_min) continue

    // Deliberately an error rather than a skip. A candidate that reached here
    // without being checked is a caller that forgot, and treating that silently
    // as "nothing found" is precisely how a competing page gets published.
    const coverage = input.coverage.get(candidate.keyword)
    if (!coverage) throw new UncheckedCandidateError(candidate.keyword)
    if (coverage.strength === 'strong') continue

    out.push({
      signalType: 'uncovered_commercial_query',
      keyword: candidate.keyword,
      intentClass: candidate.intentClass,
      monthlySearchVolume: candidate.monthlySearchVolume,
      familyIds: backed,
      source: candidate.source,
      weakExistingTarget: coverage.strength === 'weak' ? (coverage.url ?? null) : null,
      evidence: facts(input.fetchedAt, [
        { key: 'keyword', value: candidate.keyword, source: INVENTORY_SOURCE },
        { key: 'monthly_search_volume', value: candidate.monthlySearchVolume ?? 'unknown', source: 'dataforseo' },
        { key: 'intent_class', value: candidate.intentClass, source: INVENTORY_SOURCE },
        { key: 'mapped_families_with_substance', value: backed.length, source: INVENTORY_SOURCE },
        { key: 'keyword_source', value: candidate.source, source: INVENTORY_SOURCE },
        { key: 'existing_target_match', value: coverage.strength, source: INVENTORY_SOURCE },
        ...(coverage.strength === 'weak' && coverage.url
          ? [{ key: 'existing_target_url', value: coverage.url, source: INVENTORY_SOURCE }]
          : []),
        // One fact per mapped family — the `TopicScheduler`/`Opportunity`
        // contract has no channel for an array (DECISIONS 2026-09-03 T4.2's
        // flagged gap), so a repeated key is the encoding. `backed`, not
        // `candidate.familyIds`: the families this opportunity is actually
        // backed by, the ones a generated article would draw from.
        ...backed.map((familyId) => ({ key: 'family_id', value: familyId, source: INVENTORY_SOURCE })),
      ]),
    })
  }

  return out
}

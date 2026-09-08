import type { GatesConfig } from '@sortiva/rules'
import type { EvidenceFact, IntentClass } from '../contracts/opportunities'
import { INVENTORY_SOURCE, facts } from './types'
import { clearsDemandFloor, type KeywordCandidate } from './candidates'
import type { ProductShortfall, SubstanceInventory } from './substance'

/**
 * There is a real opportunity here and we cannot honestly take it, because the
 * store's own product pages do not say enough.
 *
 * This is the signal that refuses to write. Everything else about the candidate
 * is right — people are searching, the store could rank, the products are the
 * right products — and the descriptions behind them are adjectives. An article
 * written from that is padding, and padding is the failure the whole quality
 * apparatus exists to prevent, so the answer is to go back to the merchant with
 * a specific list: these products, these missing details.
 *
 * It is a held opportunity rather than a rejected one. Nothing is discarded:
 * the merchant fills the gaps, the next scan sees the catalogue has changed,
 * and the same candidate comes back able to proceed.
 */

export interface RichnessGapSignal {
  readonly signalType: 'catalog_richness_gap'
  readonly keyword: string
  readonly intentClass: IntentClass
  readonly monthlySearchVolume: number | null
  readonly familyIds: readonly string[]
  /** How much the catalogue falls short by, in the terms the floor is stated in. */
  readonly distinctFacts: number
  readonly contributingProducts: number
  /** The merchant's task, product by product and field by field. */
  readonly shortfalls: readonly ProductShortfall[]
  readonly evidence: readonly EvidenceFact[]
}

export interface RichnessGapCandidate extends KeywordCandidate {
  /**
   * How likely this store is to reach a useful position for the search, 0–1.
   * Calibrated from Search Console where it exists; a single pessimistic
   * constant for a store without it.
   */
  readonly winnability: number
  /** The floor's verdict for this candidate's mapped families, already computed. */
  readonly substance: SubstanceInventory
}

export interface RichnessGapInput {
  readonly candidates: readonly RichnessGapCandidate[]
  readonly gates: Pick<GatesConfig, 'demand_floor' | 'winnability' | 'substance_floor'>
  readonly fetchedAt: string
}

/**
 * Fires only for candidates that would otherwise go ahead.
 *
 * A search nobody makes, or one this store could never rank for, is not held
 * back by thin descriptions — it was never going anywhere. Reporting those as
 * catalogue work would hand the merchant a list of chores with nothing at the
 * end of it.
 */
export function detectCatalogRichnessGaps(
  input: RichnessGapInput,
): readonly RichnessGapSignal[] {
  const out: RichnessGapSignal[] = []

  for (const candidate of input.candidates) {
    if (!clearsDemandFloor(candidate, input.gates.demand_floor)) continue
    if (candidate.winnability < input.gates.winnability.minimum) continue
    if (candidate.substance.passes) continue

    out.push({
      signalType: 'catalog_richness_gap',
      keyword: candidate.keyword,
      intentClass: candidate.intentClass,
      monthlySearchVolume: candidate.monthlySearchVolume,
      familyIds: candidate.substance.familyIds,
      distinctFacts: candidate.substance.distinctFacts,
      contributingProducts: candidate.substance.contributingProducts,
      shortfalls: candidate.substance.shortfalls,
      evidence: facts(input.fetchedAt, [
        { key: 'keyword', value: candidate.keyword, source: INVENTORY_SOURCE },
        { key: 'monthly_search_volume', value: candidate.monthlySearchVolume ?? 'unknown', source: 'dataforseo' },
        { key: 'winnability', value: candidate.winnability, source: INVENTORY_SOURCE },
        { key: 'distinct_facts', value: candidate.substance.distinctFacts, source: 'catalog' },
        {
          key: 'distinct_facts_required',
          value: input.gates.substance_floor.distinct_facts_min,
          source: 'catalog',
        },
        { key: 'contributing_products', value: candidate.substance.contributingProducts, source: 'catalog' },
        {
          key: 'contributing_products_required',
          value: input.gates.substance_floor.contributing_products_min,
          source: 'catalog',
        },
        { key: 'products_needing_detail', value: candidate.substance.shortfalls.length, source: 'catalog' },
      ]),
    })
  }

  return out
}

/**
 * The searches whose products now say enough — the exact opposite reading of
 * `detectCatalogRichnessGaps`'s substance test, over the same measurement.
 *
 * A hold is the only piece of work in this product the merchant does rather
 * than us, so an expiring hold is the only expiry that can mean "they did it".
 * Telling the two apart needs the measurement that raised the hold taken again
 * on today's catalogue: if the products behind the search clear the substance
 * floor, the checklist we handed them is genuinely finished. Every other way a
 * hold can stop being detected — the search lost its demand, the store stopped
 * looking winnable, the keyword left the candidate set — leaves the products
 * exactly as thin as they were, and must not be read as work done.
 *
 * Deliberately ignores the demand and winnability floors that gate detection.
 * A merchant who filled in the details has filled them in whether or not the
 * search they were asked for is still worth writing about, and marking their
 * work undone because Google's volume estimate moved would be the more
 * dishonest of the two answers.
 */
export function keywordsClearingSubstanceFloor(input: RichnessGapInput): ReadonlySet<string> {
  const cleared = new Set<string>()
  for (const candidate of input.candidates) {
    if (candidate.substance.passes) cleared.add(candidate.keyword)
  }
  return cleared
}

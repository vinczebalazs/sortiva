import type { IntentClass } from '../contracts/opportunities'

/**
 * A search the store might want to be found for, and what we know about it
 * before spending anything.
 *
 * These arrive from three places — the terms the merchant confirmed at
 * onboarding, the near-variants the vendor expands them into, and the searches
 * a competitor already ranks for — and every catalogue-driven signal starts
 * from the same list, so the shape is shared rather than repeated.
 */
export interface KeywordCandidate {
  readonly keyword: string
  /** Average monthly searches, as the vendor reports it. Null where we never got a number. */
  readonly monthlySearchVolume: number | null
  readonly intentClass: IntentClass
  /** The product families this search maps to. Empty means the store does not sell into it. */
  readonly familyIds: readonly string[]
  readonly source: 'merchant_seed' | 'related_expansion' | 'competitor'
  /** The merchant asked for this one by hand, which overrides our judgement about volume. */
  readonly pinned?: boolean
}

/**
 * Which searches are worth an article at all.
 *
 * A shopper comparing options or working out what to buy is someone the store
 * can serve and sell to. Someone looking up a definition is not — writing for
 * them fills a calendar and sells nothing, which is the "ecommerce context
 * first" rule stated as a filter.
 */
const COMMERCIAL_INTENTS: ReadonlySet<IntentClass> = new Set<IntentClass>([
  'buying_guide',
  'comparison',
])

export function isCommercialIntent(intentClass: IntentClass): boolean {
  return COMMERCIAL_INTENTS.has(intentClass)
}

/**
 * Does this search get searched enough to be worth an article?
 *
 * A merchant who pinned a topic has overridden our judgement on purpose, so a
 * missing or zero volume does not veto them; whether that override is allowed
 * is itself a number in `packages/rules`.
 */
export function clearsDemandFloor(
  candidate: KeywordCandidate,
  floor: { readonly monthly_search_volume_min: number; readonly allow_zero_volume_when_pinned: boolean },
): boolean {
  if (candidate.pinned && floor.allow_zero_volume_when_pinned) return true
  if (candidate.monthlySearchVolume === null) return false
  return candidate.monthlySearchVolume >= floor.monthly_search_volume_min
}

/**
 * What the existing-target check found for this search, reduced to what a
 * detector is allowed to know.
 *
 * Detectors say what is true and never what to do about it, so the strength of
 * the match travels here and the decision it implies does not.
 */
export interface ExistingCoverage {
  readonly strength: 'none' | 'weak' | 'strong'
  /** The page found, where one was. A weak match's address is what the new page has to link to. */
  readonly url?: string
}

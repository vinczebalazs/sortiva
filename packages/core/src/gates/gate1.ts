import type { GatesConfig } from '@sortiva/rules'
import type { EvidenceFact, ExistingTargetOutcome, QueryCluster } from '../contracts/opportunities'
import { INVENTORY_SOURCE, facts } from '../signals/types'
import { clearsDemandFloor } from '../signals/candidates'
import type { SubstanceInventory } from '../signals/substance'

/**
 * Gate 1 — topic admission, before anything is written.
 *
 * Five checks, all data-driven and all free: is anyone searching for this, can
 * this store realistically rank for it, do the mapped products say enough to
 * write about honestly, does the store already have a page for it, and does it
 * sell into the intent at all. Main §8.2.
 *
 * The fourth check — "does the store already have a page for it" — is
 * `existingTargetCheck`, the cannibalization check from main §7.7. It is the
 * same function everywhere it runs (invariant 6): this file does not
 * recompute it, it takes the answer as an input and reacts to it, so this
 * gate and the Opportunity Engine's own admission can never disagree about
 * whether a page already exists.
 */

/** The vocabulary for `gate_decisions.outcome` (free text — see DECISIONS 2026-09-03 T4.0). Defined here, this card's own call. */
export const GATE1_OUTCOMES = [
  'admitted',
  'admitted_pinned_despite_zero_volume',
  'admitted_with_warning',
  'converted_to_optimize',
  'converted_to_refresh',
  'held_insufficient_substance',
  'rejected_off_catalog',
  'rejected_zero_volume',
  'rejected_not_winnable',
] as const
export type Gate1OutcomeKind = (typeof GATE1_OUTCOMES)[number]

/**
 * When a held-back topic can resolve itself without the merchant re-asking.
 * Main §8.6/§8.2's "how the calendar behaves when the store or the search
 * results change" is stated in prose, never as a field on anything — this
 * enum is this card's own reading of it, so the reason card can say more than
 * "no" (build-plan card text, "so a held-back topic resolves itself when the
 * merchant acts instead of becoming a dead end").
 */
export type Gate1RetryCondition = 'on_catalog_update' | 'on_next_search_scan' | 'never'

/**
 * The words a merchant reads, as a key and its numbers rather than prose this
 * module composed — the same discipline `packages/ui`'s why-line renderer
 * already applies to opportunities (invariant 8: never render english here).
 */
export interface Gate1ReasonCard {
  readonly templateKey: string
  readonly params: Readonly<Record<string, string | number>>
  readonly retryCondition: Gate1RetryCondition
  /** A page the merchant can go act on right now, where one exists. */
  readonly redirectUrl: string | null
}

/** Set on a weak existing-target match: the new page must link to and from this one. Main §7.7 step 4. */
export interface Gate1LinkTask {
  readonly existingUrl: string
  readonly via: 'gsc' | 'content_mapping' | 'limited_intelligence'
}

/** Set when the existing-target check found a strong match: no CREATE, this becomes the work instead. */
export interface Gate1Conversion {
  readonly action: 'optimize' | 'refresh'
  readonly url: string
  readonly via: 'gsc' | 'content_mapping' | 'limited_intelligence'
  readonly position: number | null
}

export interface Gate1Result {
  readonly outcome: Gate1OutcomeKind
  /** True for every `admitted*` outcome; false for `converted_*`, `held_*` and `rejected_*`. */
  readonly admitted: boolean
  readonly linkTask: Gate1LinkTask | null
  readonly conversion: Gate1Conversion | null
  /** Null exactly when `outcome === 'admitted'` — nothing to explain. */
  readonly reasonCard: Gate1ReasonCard | null
  readonly evidence: readonly EvidenceFact[]
}

export interface Gate1Input {
  readonly cluster: QueryCluster
  /** Average monthly searches for the cluster's head term. Null where nothing measured it. */
  readonly monthlySearchVolume: number | null
  /** The merchant pinned this topic, which overrides a zero-volume reading — same rule `clearsDemandFloor` already applies for detection. */
  readonly pinned: boolean
  /**
   * True for the manual-add path (main §8.7): the merchant chose the subject,
   * so a demand-floor failure alone softens from an auto-reject into a
   * warning the candidate still proceeds under. Every other check still
   * blocks a manual topic exactly like an auto one.
   */
  readonly manual: boolean
  /**
   * 0–1. Can this store realistically rank for this. Gate 1 only compares it
   * to the floor — where the number itself comes from (GSC-calibrated
   * authority, or the Limited Intelligence constant) is the caller's job; see
   * `packages/jobs/src/generation/admit-manual-topic.ts` for why this card
   * always passes the constant today.
   */
  readonly winnability: number
  readonly limitedIntelligence: boolean
  readonly substance: SubstanceInventory
  readonly existingTarget: ExistingTargetOutcome
  readonly gates: GatesConfig
  readonly fetchedAt: string
}

function reasonCard(
  templateKey: string,
  params: Readonly<Record<string, string | number>>,
  retryCondition: Gate1RetryCondition,
  redirectUrl: string | null = null,
): Gate1ReasonCard {
  return { templateKey, params, retryCondition, redirectUrl }
}

/**
 * Runs the gate.
 *
 * Order matters only for which reason a candidate that fails more than one
 * check is shown — a topic with no family mapping at all is told "off
 * catalog" rather than "not enough substance", because there is nothing to
 * measure substance over. Every check still runs against the caller-supplied
 * data; nothing here makes a network or model call, which is what "gate 1 is
 * free" means in practice.
 */
export function runGate1(input: Gate1Input): Gate1Result {
  const evidence = buildEvidence(input)

  // Demand floor. A manual candidate that fails only this one still proceeds
  // — the merchant chose the subject — but every later check can still stop
  // it outright, so the warning is provisional until the rest have run.
  const clearsFloor = clearsDemandFloor(
    { keyword: input.cluster.head, monthlySearchVolume: input.monthlySearchVolume, intentClass: input.cluster.intentClass, familyIds: input.cluster.familyIds, source: 'merchant_seed', pinned: input.pinned },
    input.gates.demand_floor,
  )
  const pinnedRescue =
    input.pinned &&
    input.gates.demand_floor.allow_zero_volume_when_pinned &&
    (input.monthlySearchVolume === null || input.monthlySearchVolume < input.gates.demand_floor.monthly_search_volume_min)
  let pendingWarning: Gate1ReasonCard | null = null

  if (!clearsFloor) {
    if (!input.manual) {
      return rejected('rejected_zero_volume', demandFloorReason(input), evidence)
    }
    pendingWarning = demandFloorReason(input)
  }

  // Winnability. Not softened for manual topics: the spec's "heads up" wording
  // is specifically about search volume, never about whether the store could
  // plausibly rank at all.
  if (input.winnability < input.gates.winnability.minimum) {
    return rejected(
      'rejected_not_winnable',
      reasonCard(
        'gate1.rejected_not_winnable',
        { keyword: input.cluster.head, winnability: round2(input.winnability), minimum: input.gates.winnability.minimum },
        'on_next_search_scan',
      ),
      evidence,
    )
  }

  // Intent & commercial relevance. Checked before substance because substance
  // has nothing to measure without at least one mapped family — an
  // informational query nobody sells into is "off catalog", not "thin".
  if (input.cluster.familyIds.length === 0) {
    return rejected(
      'rejected_off_catalog',
      reasonCard('gate1.rejected_off_catalog', { keyword: input.cluster.head }, 'on_catalog_update'),
      evidence,
    )
  }

  // Existing-target / cannibalization check — main §7.7, literally the same
  // function as the Opportunity Engine's own admission. Checked before
  // substance on purpose: a strong match means no CREATE happens at all, so
  // whether the catalogue says enough to write a *new* article is moot — a
  // store whose products are too thin to cover a topic, but which already
  // ranks for it, should be sent to improve the page it has, not told to add
  // product details for an article it was never going to get anyway.
  const conversion = conversionFor(input.existingTarget)
  if (conversion) {
    const via = conversion.via
    return {
      outcome: conversion.action === 'optimize' ? 'converted_to_optimize' : 'converted_to_refresh',
      admitted: false,
      linkTask: null,
      conversion,
      reasonCard: reasonCard(
        conversion.action === 'optimize'
          ? 'gate1.converted_existing_target_optimize'
          : 'gate1.converted_existing_target_refresh',
        { keyword: input.cluster.head, url: conversion.url, via },
        'never',
        conversion.url,
      ),
      evidence,
    }
  }

  const linkTask = linkTaskFor(input.existingTarget)

  // Substance inventory. A HOLD, not a flat no: main §7.8 treats this as
  // resumable merchant work, so the outcome name says "held" rather than
  // "rejected".
  if (!input.substance.passes) {
    return rejected(
      'held_insufficient_substance',
      reasonCard(
        'gate1.held_insufficient_substance',
        {
          keyword: input.cluster.head,
          distinct_facts: input.substance.distinctFacts,
          distinct_facts_required: input.gates.substance_floor.distinct_facts_min,
          products_needing_detail: input.substance.shortfalls.length,
        },
        'on_catalog_update',
      ),
      evidence,
    )
  }

  if (pendingWarning) {
    return {
      outcome: 'admitted_with_warning',
      admitted: true,
      linkTask,
      conversion: null,
      reasonCard: pendingWarning,
      evidence,
    }
  }

  if (pinnedRescue) {
    return {
      outcome: 'admitted_pinned_despite_zero_volume',
      admitted: true,
      linkTask,
      conversion: null,
      reasonCard: reasonCard(
        'gate1.admitted_pinned_despite_zero_volume',
        { keyword: input.cluster.head },
        'never',
      ),
      evidence,
    }
  }

  return { outcome: 'admitted', admitted: true, linkTask, conversion: null, reasonCard: null, evidence }
}

function rejected(outcome: Gate1OutcomeKind, reason: Gate1ReasonCard, evidence: readonly EvidenceFact[]): Gate1Result {
  return { outcome, admitted: false, linkTask: null, conversion: null, reasonCard: reason, evidence }
}

function demandFloorReason(input: Gate1Input): Gate1ReasonCard {
  return reasonCard(
    'gate1.rejected_zero_volume',
    {
      keyword: input.cluster.head,
      monthly_search_volume: input.monthlySearchVolume ?? 0,
      monthly_search_volume_min: input.gates.demand_floor.monthly_search_volume_min,
    },
    'on_next_search_scan',
  )
}

function conversionFor(outcome: ExistingTargetOutcome): Gate1Conversion | null {
  if (outcome.match !== 'strong') return null
  return {
    action: outcome.action === 'REFRESH' ? 'refresh' : 'optimize',
    url: outcome.url,
    via: outcome.via,
    position: outcome.position ?? null,
  }
}

function linkTaskFor(outcome: ExistingTargetOutcome): Gate1LinkTask | null {
  if (outcome.match !== 'weak') return null
  return { existingUrl: outcome.url, via: outcome.via }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function buildEvidence(input: Gate1Input): readonly EvidenceFact[] {
  return facts(input.fetchedAt, [
    { key: 'keyword', value: input.cluster.head, source: INVENTORY_SOURCE },
    { key: 'intent_class', value: input.cluster.intentClass, source: INVENTORY_SOURCE },
    { key: 'mapped_family_count', value: input.cluster.familyIds.length, source: INVENTORY_SOURCE },
    { key: 'monthly_search_volume', value: input.monthlySearchVolume ?? 'unknown', source: 'dataforseo' },
    { key: 'winnability', value: round2(input.winnability), source: INVENTORY_SOURCE },
    { key: 'distinct_facts', value: input.substance.distinctFacts, source: 'catalog' },
    { key: 'contributing_products', value: input.substance.contributingProducts, source: 'catalog' },
    { key: 'existing_target_match', value: input.existingTarget.match, source: INVENTORY_SOURCE },
  ])
}

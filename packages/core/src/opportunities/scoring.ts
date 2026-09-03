import type { ScoringConfig } from '@sortiva/rules'
import type { ConfidenceBand, EvidenceFact, ImpactBand } from '../contracts/opportunities'
import { GSC_SOURCE } from '../signals/types'

/**
 * Turning what a detector measured into two numbers the merchant never sees
 * the arithmetic behind: how much this is worth (impact) and how sure we are
 * of the diagnosis (confidence). Kept apart on purpose — a confidently
 * detected low-value page and a huge but shaky one are different cards, and
 * folding them into one score would hide that from the person deciding what
 * to work on next.
 *
 * Every function here is pure: numbers in, numbers out. Nothing reads the
 * database, so the same input always produces the same output and a test can
 * hold every threshold steady while it varies one fact.
 */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// ── CREATE candidates: main §7.6 / §9.6.4 ───────────────────────────────────

export interface CreateScoreInput {
  /** Average monthly searches. Null or non-positive reads as no demonstrated demand rather than throwing — a pinned topic can reach here with none. */
  readonly monthlySearchVolume: number | null
  /**
   * Can this store realistically rank for it, 0–1. Gate 1's own calibration
   * (main §8.2) produces this number; this function only spends it. A caller
   * with nothing better passes `gates.winnability.limited_intelligence_constant`.
   */
  readonly winnability: number
  /** The (≤3) active pattern multipliers this candidate matches — main §9.6.3. Empty when nothing is active yet, which is every store's first scan. */
  readonly patternMultipliers: readonly number[]
  /** Competitor-gap candidates carry proof that ranking is achievable in this niche — main §9.6.4. */
  readonly isCompetitorGapSourced: boolean
  /** A family-coverage-gap candidate's revenue share, rescaled to `[business_weight_min, business_weight_max]`. `1.0` (no effect) for every other signal. */
  readonly businessWeight: number
}

/**
 * `log(volume) × winnability`, then the pattern and source multipliers,
 * exactly as §9.6.4 states it.
 *
 * `log(volume + 1)` rather than `log(volume)`: a pinned zero-volume topic
 * (allowed by `gates.demand_floor.allow_zero_volume_when_pinned`) would
 * otherwise take `log(0)`, which is `-Infinity` and poisons every downstream
 * comparison. Shifting by one gives a pinned, volume-less topic a base
 * opportunity of zero — the lowest real score, not an undefined one — and
 * changes nothing for any candidate with real volume behind it. Undictated;
 * see DECISIONS.
 */
export function createOpportunityScore(
  input: CreateScoreInput,
  scoring: Pick<ScoringConfig, 'create'>,
): number {
  const volume = Math.max(input.monthlySearchVolume ?? 0, 0)
  const opportunity = Math.log(volume + 1) * input.winnability
  const patternMultiplier = clampedProduct(
    input.patternMultipliers,
    // The clamp is stated once, on the stacked pattern effect (main §9.6.3);
    // scoring takes the two numbers rather than the whole learning config so
    // it stays a function of exactly what it uses.
    { min: PATTERN_CLAMP.min, max: PATTERN_CLAMP.max },
  )
  const sourceBonus = input.isCompetitorGapSourced ? scoring.create.competitor_gap_source_bonus : 1
  return opportunity * patternMultiplier * sourceBonus * input.businessWeight
}

/**
 * Main §9.6.3's clamp (`[0.5, 2.0]`) is a property of the learning config, not
 * the scoring config — passed by the caller where it matters (build.ts);
 * defaulted here only so `createOpportunityScore` has a sane clamp when a
 * caller has not resolved any patterns yet (the product of an empty list).
 */
const PATTERN_CLAMP = { min: 0.5, max: 2.0 }

function clampedProduct(values: readonly number[], bounds: { min: number; max: number }): number {
  const raw = values.reduce((product, value) => product * value, 1)
  return clamp(raw, bounds.min, bounds.max)
}

/**
 * A family-coverage-gap candidate's revenue share, rescaled into
 * `[business_weight_min, business_weight_max]` — main §7.6's "ecommerce
 * context first" principle as one number. Every other signal passes `1.0`
 * (unchanged) because revenue share is only meaningful for a family-level
 * candidate.
 */
export function businessWeight(
  revenueShare: number,
  config: ScoringConfig['create'],
): number {
  const share = clamp(revenueShare, 0, 1)
  return config.business_weight_min + share * (config.business_weight_max - config.business_weight_min)
}

// ── Existing-page candidates (OPTIMIZE / REFRESH): main §9.6.5 ─────────────

/**
 * `impressions × (CTR(target) − CTR(current))`, where `target` is picked per
 * signal exactly as §7.6 states: striking distance moves toward a modest
 * target position; low CTR recovers to what the store's own curve already
 * predicts at the position it holds; decay recovers to the position it used
 * to hold. A negative result (the "improvement" would cost clicks) floors at
 * zero — there is no such thing as negative expected gain, only no gain yet
 * modelled.
 */
export function existingPageExpectedGain(input: {
  readonly impressions: number
  readonly currentCtr: number
  readonly targetCtr: number
}): number {
  return Math.max(0, input.impressions * (input.targetCtr - input.currentCtr))
}

// ── Comparability: percentile rank within the action family, main §7.6 ─────

export interface ImpactConfig {
  readonly score_min: number
  readonly score_max: number
  readonly band_tercile_low_max_percentile: number
  readonly band_tercile_medium_max_percentile: number
}

export interface ImpactResult {
  readonly impactScore: number
  readonly impact: ImpactBand
}

/**
 * Where this candidate's raw score sits among every other open candidate of
 * the *same recommended action* for this store — never across stores, never
 * across actions, because a CREATE score and an OPTIMIZE score are not on one
 * scale (§7.6's own words). `familyScores` is expected to already include
 * this candidate's own score; a caller re-scoring the whole open set passes
 * the same array to every candidate in it.
 *
 * Percentile rank uses the midpoint convention — half credit for ties — so a
 * three-way tie doesn't hand every one of them the same extreme band. This is
 * one valid definition among several the spec doesn't pick; see DECISIONS.
 */
export function percentileImpact(
  rawScore: number,
  familyScores: readonly number[],
  config: ImpactConfig,
): ImpactResult {
  const n = familyScores.length
  if (n === 0) {
    return { impactScore: config.score_max, impact: 'high' }
  }
  const below = familyScores.filter((score) => score < rawScore).length
  const atOrBelow = familyScores.filter((score) => score <= rawScore).length
  const percentile = ((below + atOrBelow) / 2 / n) * 100
  const impactScore = Math.round(clamp(percentile, config.score_min, config.score_max))
  const impact: ImpactBand =
    percentile <= config.band_tercile_low_max_percentile
      ? 'low'
      : percentile <= config.band_tercile_medium_max_percentile
        ? 'medium'
        : 'high'
  return { impactScore, impact }
}

/**
 * A raw score for the signals main §9.6.4/§9.6.5 give no formula for at all —
 * cannibalization, missing/weak metadata, a competitor-gap OPTIMIZE, and the
 * P1-shaped `existing_page_intent_gap`/`indexing_issue`. Rather than invent a
 * bespoke formula per signal for cases the spec is silent on, this reads the
 * largest impressions-shaped number already sitting in the signal's own
 * evidence — real traffic where a signal happens to carry it (cannibalization
 * does), a constant floor of `1` where none exists (metadata, indexing).
 * Monotonic and non-zero is all percentile ranking needs; see DECISIONS.
 */
export function fallbackMagnitude(evidence: readonly EvidenceFact[]): number {
  let max = 0
  for (const fact of evidence) {
    if (!/impressions/.test(fact.key)) continue
    const value = typeof fact.value === 'number' ? fact.value : Number(fact.value)
    if (Number.isFinite(value) && value > max) max = value
  }
  return max > 0 ? max : 1
}

// ── Confidence: additive, deterministic, main §7.6 ──────────────────────────

export interface ConfidenceInput {
  readonly evidence: readonly EvidenceFact[]
  /** Empty means no open precondition. */
  readonly preconditions: readonly string[]
  readonly limitedIntelligence: boolean
  /** The mapped families clear the substance floor with margin — only meaningful for family-backed candidates. */
  readonly substanceFloorMargin?: boolean
  /** The signal held on ≥2 consecutive weekly scans. Only `content_decay` carries this today; everything else defaults to false until the scan job tracks it. */
  readonly validatedAcrossConsecutiveScans?: boolean
}

export interface ConfidenceResult {
  readonly confidence: number
  readonly band: ConfidenceBand
}

/** The longest window named on any evidence fact, in days. `0` when nothing carries one (every catalogue/market signal). */
function maxEvidenceWindowDays(evidence: readonly EvidenceFact[]): number {
  let max = 0
  for (const fact of evidence) {
    const match = /^(\d+)d/.exec(fact.window ?? '')
    if (!match) continue
    const days = Number(match[1])
    if (days > max) max = days
  }
  return max
}

/**
 * "≥2 independent sources agree" is read as ≥2 distinct evidence sources on
 * the same detection — GSC plus the content inventory, or GSC plus the search
 * vendor. The spec names the concept without defining it at implementation
 * level; this is the reading taken. See DECISIONS.
 */
function independentSourceCount(evidence: readonly EvidenceFact[]): number {
  return new Set(evidence.map((fact) => fact.source)).size
}

export function confidenceScore(
  input: ConfidenceInput,
  scoring: ScoringConfig['confidence'],
): ConfidenceResult {
  const points = scoring.points
  const windowDays = maxEvidenceWindowDays(input.evidence)
  let score = 0

  if (input.evidence.some((fact) => fact.source === GSC_SOURCE)) score += points.gsc_evidence_present
  if (windowDays >= scoring.evidence_window_days_tier_1) score += points.evidence_window_at_least_28_days
  if (windowDays >= scoring.evidence_window_days_tier_2) score += points.evidence_window_at_least_84_days
  if (independentSourceCount(input.evidence) >= scoring.independent_sources_min) {
    score += points.independent_sources_agree
  }
  if (input.substanceFloorMargin) score += points.substance_floor_margin
  if (input.preconditions.length === 0) score += points.no_open_precondition
  if (input.validatedAcrossConsecutiveScans) score += points.validated_across_consecutive_scans
  if (input.limitedIntelligence) score += points.limited_intelligence_penalty

  const confidence = Math.round(clamp(score, scoring.clamp_min, scoring.clamp_max))
  const band: ConfidenceBand =
    confidence >= scoring.band_high_min ? 'high' : confidence >= scoring.band_medium_min ? 'medium' : 'low'
  return { confidence, band }
}

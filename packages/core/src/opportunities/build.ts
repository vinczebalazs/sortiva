import type { ScoringConfig } from '@sortiva/rules'
import type {
  ConfidenceBand,
  EvidenceFact,
  ImpactBand,
  OpportunityAction,
  OpportunityStatus,
} from '../contracts/opportunities'
import { expectedCtrAt, type CtrCurve } from '../search'
import {
  selectAction,
  type ActionSelectionContext,
  type DetectedSignal,
} from './action-selection'
import { reasonFor } from './reasons'
import {
  businessWeight as scaleBusinessWeight,
  confidenceScore,
  createOpportunityScore,
  existingPageExpectedGain,
  fallbackMagnitude,
  percentileImpact,
  type ImpactConfig,
} from './scoring'
import { generateTasks, type OpportunityTaskDraft } from './tasks'

/**
 * Where signal detection (§7.3) ends and the opportunity object (§7.6) begins:
 * one signal, plus everything a caller has to supply because this module has
 * no database and no clock of its own, in — one fully-scored, fully-explained
 * candidate out. The only thing missing at this point is `impactScore`/`impact`,
 * because a percentile rank needs the whole batch of open candidates in the
 * same action family; `rankByImpact` below is the second pass that adds it.
 */

export interface OpportunityBuildContext {
  readonly accountId: string
  readonly limitedIntelligence: boolean
  /** The hash of `signals.config.yaml` that produced this row — main §7.10. */
  readonly rulesVersion: string
  /**
   * Can this store realistically rank, 0–1. Gate 1's own calibration (main
   * §8.2) is Lane D's territory; a caller with nothing better passes
   * `gates.winnability.limited_intelligence_constant`. Only spent on
   * CREATE-family candidates.
   */
  readonly winnability: number
  /** Only spent by `striking_distance` and `content_decay`, whose gain formula needs a position→CTR lookup. Absent falls back to a traffic-magnitude proxy rather than throwing. */
  readonly ctrCurve?: CtrCurve
  /** The (≤3) active pattern multipliers this candidate matches — main §9.6.3. Resolving which patterns are active is a database lookup outside this module; empty is every store's first scan. */
  readonly patternMultipliers?: readonly number[]
  /** Passed in, never read from the clock, so building a draft is a function of its inputs. */
  readonly detectedAt: string
  readonly technicalBlocker?: ActionSelectionContext['openTechnicalBlocker']
  /** The mapped families clear the substance floor with margin — main §7.6's confidence point. Only meaningful for CREATE-family candidates backed by families. */
  readonly substanceFloorMargin?: boolean
}

/** Everything about one opportunity except its percentile rank, which needs the rest of the batch. */
export interface OpportunityDraft {
  readonly accountId: string
  readonly signalType: string
  readonly entityType: 'query_cluster' | 'url' | 'family' | 'article' | 'product'
  readonly entityRef: string
  readonly evidence: readonly EvidenceFact[]
  readonly confidence: number
  readonly confidenceBand: ConfidenceBand
  readonly reasonTemplateKey: string
  readonly reasonParams: Readonly<Record<string, string | number>>
  readonly recommendedAction: OpportunityAction
  readonly preconditions: readonly string[]
  readonly status: OpportunityStatus
  readonly rulesVersion: string
  readonly limitedIntelligence: boolean
  readonly detectedAt: string
  /** Not on the `opportunities` table — the input `rankByImpact` turns into `impact_score`/`impact`. */
  readonly rawScore: number
  readonly tasks: readonly OpportunityTaskDraft[]
}

export interface RankedOpportunityDraft extends OpportunityDraft {
  readonly impactScore: number
  readonly impact: ImpactBand
}

/**
 * Main §7.9: preconditions block everything (HOLD renders as `blocked`);
 * otherwise CREATE/REFRESH auto-accept (the calendar's own veto/move/pin
 * controls are the merchant's lever, not an approval click) and everything
 * else — OPTIMIZE, FIX — starts `new`, waiting on the merchant.
 */
function initialStatus(action: OpportunityAction, preconditions: readonly string[]): OpportunityStatus {
  if (preconditions.length > 0) return 'blocked'
  if (action === 'CREATE' || action === 'REFRESH') return 'accepted'
  return 'new'
}

/**
 * The CREATE formula (main §7.6/§9.6.4), spent only on the three signals that
 * actually propose new coverage. `product_family_coverage_gap` has no single
 * keyword and so no `monthlySearchVolume` field on its signal at all — the
 * count of keyword candidates already clearing the demand floor stands in for
 * it, which is an approximation this card is making, not a number the
 * detector (already merged) asserts. See DECISIONS.
 */
function createFamilyScore(
  signal: DetectedSignal,
  ctx: OpportunityBuildContext,
  scoring: ScoringConfig,
): number {
  const shared = { winnability: ctx.winnability, patternMultipliers: ctx.patternMultipliers ?? [] }
  switch (signal.signalType) {
    case 'uncovered_commercial_query':
      return createOpportunityScore(
        { ...shared, monthlySearchVolume: signal.monthlySearchVolume, isCompetitorGapSourced: false, businessWeight: 1 },
        scoring,
      )
    case 'competitor_coverage_gap':
      return createOpportunityScore(
        { ...shared, monthlySearchVolume: signal.monthlySearchVolume, isCompetitorGapSourced: true, businessWeight: 1 },
        scoring,
      )
    case 'product_family_coverage_gap':
      return createOpportunityScore(
        {
          ...shared,
          monthlySearchVolume: signal.keywordCandidatesClearingFloor,
          isCompetitorGapSourced: false,
          businessWeight: scaleBusinessWeight(signal.revenueShare, scoring.create),
        },
        scoring,
      )
    default:
      // selectAction never returns CREATE for any other signal type; a change
      // there without a matching case here is a bug this throw catches in
      // tests rather than silently mis-scoring.
      throw new Error(`createFamilyScore: unexpected CREATE signal "${signal.signalType}"`)
  }
}

/**
 * The existing-page gain formula (main §7.6/§9.6.5), exactly for the three
 * signals it names a target position for. Every other OPTIMIZE/REFRESH/FIX/HOLD
 * signal — cannibalization, missing/weak metadata, a competitor-gap OPTIMIZE,
 * and the two P1-shaped signals — has no formula stated anywhere in the spec,
 * so it falls back to `fallbackMagnitude`. See DECISIONS.
 */
function existingPageGain(
  signal: DetectedSignal,
  ctx: OpportunityBuildContext,
  scoring: ScoringConfig,
): number {
  switch (signal.signalType) {
    case 'striking_distance': {
      if (!ctx.ctrCurve) return fallbackMagnitude(signal.evidence)
      const current = expectedCtrAt(ctx.ctrCurve, signal.position)
      const target = expectedCtrAt(ctx.ctrCurve, scoring.existing_page.striking_distance_target_position)
      if (current === null || target === null) return fallbackMagnitude(signal.evidence)
      return existingPageExpectedGain({ impressions: signal.clusterImpressions, currentCtr: current, targetCtr: target })
    }
    case 'low_ctr_at_strong_rank':
      return existingPageExpectedGain({
        impressions: signal.clusterImpressions,
        currentCtr: signal.observedCtr,
        targetCtr: signal.predictedCtr,
      })
    case 'content_decay': {
      if (!ctx.ctrCurve) return fallbackMagnitude(signal.evidence)
      const current = expectedCtrAt(ctx.ctrCurve, signal.currentPosition)
      const baseline = expectedCtrAt(ctx.ctrCurve, signal.baselinePosition)
      if (current === null || baseline === null) return fallbackMagnitude(signal.evidence)
      return existingPageExpectedGain({ impressions: signal.currentImpressions, currentCtr: current, targetCtr: baseline })
    }
    default:
      return fallbackMagnitude(signal.evidence)
  }
}

/** `content_decay` is the only signal today that tracks its own repeat-scan count; everything else defaults to false until the scan job (T3.7) tracks it for the rest. */
function validatedAcrossScans(signal: DetectedSignal): boolean {
  return signal.signalType === 'content_decay' ? signal.confirmed : false
}

export function buildOpportunityDraft(
  signal: DetectedSignal,
  ctx: OpportunityBuildContext,
  scoring: ScoringConfig,
): OpportunityDraft {
  const selected = selectAction(signal, { openTechnicalBlocker: ctx.technicalBlocker })
  const reason = reasonFor(signal, selected.action)
  const tasks = generateTasks(signal)
  const rawScore =
    selected.action === 'CREATE'
      ? createFamilyScore(signal, ctx, scoring)
      : existingPageGain(signal, ctx, scoring)

  const confidence = confidenceScore(
    {
      evidence: signal.evidence,
      preconditions: selected.preconditions,
      limitedIntelligence: ctx.limitedIntelligence,
      substanceFloorMargin: ctx.substanceFloorMargin ?? false,
      validatedAcrossConsecutiveScans: validatedAcrossScans(signal),
    },
    scoring.confidence,
  )

  return {
    accountId: ctx.accountId,
    signalType: signal.signalType,
    entityType: selected.entityType,
    entityRef: selected.entityRef,
    evidence: signal.evidence,
    confidence: confidence.confidence,
    confidenceBand: confidence.band,
    reasonTemplateKey: reason.reasonTemplateKey,
    reasonParams: reason.reasonParams,
    recommendedAction: selected.action,
    preconditions: selected.preconditions,
    status: initialStatus(selected.action, selected.preconditions),
    rulesVersion: ctx.rulesVersion,
    limitedIntelligence: ctx.limitedIntelligence,
    detectedAt: ctx.detectedAt,
    rawScore,
    tasks,
  }
}

/**
 * The second pass main §7.6 requires: `impact_score` is a percentile rank
 * *within the candidate's own action family*, never across the whole store —
 * a CREATE score and an OPTIMIZE score share no scale. Grouped here by
 * `recommendedAction`, so a caller ranking a whole scan's output in one call
 * gets every family compared correctly rather than having to slice the batch
 * itself.
 */
export function rankByImpact(
  drafts: readonly OpportunityDraft[],
  config: ImpactConfig,
): readonly RankedOpportunityDraft[] {
  const byAction = new Map<OpportunityAction, number[]>()
  for (const draft of drafts) {
    const list = byAction.get(draft.recommendedAction) ?? []
    list.push(draft.rawScore)
    byAction.set(draft.recommendedAction, list)
  }
  return drafts.map((draft) => {
    const family = byAction.get(draft.recommendedAction) ?? [draft.rawScore]
    const { impactScore, impact } = percentileImpact(draft.rawScore, family, config)
    return { ...draft, impactScore, impact }
  })
}

import type { AnalyticsEvent, EventAttribution } from '../contracts/analytics'
import type { OpportunityStatus } from '../contracts/opportunities'
import type { RankedOpportunityDraft } from './build'

/**
 * The three opportunity-engine events main §14.7 names, built the same way
 * `article-cost.ts` builds its own: a pure function from a domain fact to the
 * `AnalyticsEvent` shape, so the call site only has to hold a `PosthogCapture`
 * and call `.capture(...)` — nothing here reaches a network or a database.
 *
 * Properties are ids, aggregates and enum values only (never evidence text,
 * never a rendered why-line) — the same privacy rule every other event in the
 * product already keeps (main §14.7's own note, tech §1/§4).
 */

export const SIGNAL_RUN_COMPLETED_EVENT = 'signal_run_completed'
export const OPPORTUNITY_DETECTED_EVENT = 'opportunity_detected'
export const OPPORTUNITY_STATUS_CHANGED_EVENT = 'opportunity_status_changed'

export interface SignalRunSummary {
  readonly kind: 'onboarding' | 'weekly' | 'event'
  readonly rulesVersion: string
  readonly signalsEvaluated: number
  readonly opportunitiesCreated: number
  readonly opportunitiesUpdated: number
  readonly opportunitiesExpired: number
  readonly durationMs: number
}

export function signalRunCompleted(
  attribution: EventAttribution,
  summary: SignalRunSummary,
): AnalyticsEvent {
  return {
    event: SIGNAL_RUN_COMPLETED_EVENT,
    attribution,
    properties: {
      kind: summary.kind,
      rules_version: summary.rulesVersion,
      signals_evaluated: summary.signalsEvaluated,
      opportunities_created: summary.opportunitiesCreated,
      opportunities_updated: summary.opportunitiesUpdated,
      opportunities_expired: summary.opportunitiesExpired,
      duration_ms: summary.durationMs,
    },
  }
}

/** Fired once per newly-created opportunity row — never on a re-detection that only updates an open one, which is `opportunity_status_changed`'s job if the status itself moved. */
export function opportunityDetected(
  attribution: EventAttribution,
  opportunity: Pick<
    RankedOpportunityDraft,
    'signalType' | 'recommendedAction' | 'impact' | 'confidenceBand' | 'limitedIntelligence'
  >,
): AnalyticsEvent {
  return {
    event: OPPORTUNITY_DETECTED_EVENT,
    attribution,
    properties: {
      signal_type: opportunity.signalType,
      recommended_action: opportunity.recommendedAction,
      impact: opportunity.impact,
      confidence: opportunity.confidenceBand,
      limited_intelligence: opportunity.limitedIntelligence,
    },
  }
}

export type OpportunityStatusActor = 'user' | 'autopilot' | 'expiry'

export function opportunityStatusChanged(
  attribution: EventAttribution,
  change: { readonly from: OpportunityStatus | null; readonly to: OpportunityStatus; readonly actor: OpportunityStatusActor },
): AnalyticsEvent {
  return {
    event: OPPORTUNITY_STATUS_CHANGED_EVENT,
    attribution,
    properties: { from: change.from, to: change.to, actor: change.actor },
  }
}

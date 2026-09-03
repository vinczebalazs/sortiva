import { describe, expect, it } from 'vitest'
import { accountAttribution } from '../contracts/analytics'
import {
  OPPORTUNITY_DETECTED_EVENT,
  OPPORTUNITY_STATUS_CHANGED_EVENT,
  SIGNAL_RUN_COMPLETED_EVENT,
  opportunityDetected,
  opportunityStatusChanged,
  signalRunCompleted,
} from './events'

const attribution = accountAttribution('acct_1', 'shop.example.com')

describe('opportunity engine analytics events (main §14.7)', () => {
  it('signal_run_completed carries the counts the calibration review reads', () => {
    const event = signalRunCompleted(attribution, {
      kind: 'weekly',
      rulesVersion: 'abc123',
      signalsEvaluated: 40,
      opportunitiesCreated: 3,
      opportunitiesUpdated: 5,
      opportunitiesExpired: 1,
      durationMs: 900,
    })
    expect(event.event).toBe(SIGNAL_RUN_COMPLETED_EVENT)
    expect(event.properties).toMatchObject({
      kind: 'weekly',
      rules_version: 'abc123',
      opportunities_created: 3,
      opportunities_updated: 5,
      opportunities_expired: 1,
    })
  })

  it('opportunity_detected never carries evidence text, only enums and ids', () => {
    const event = opportunityDetected(attribution, {
      signalType: 'competitor_coverage_gap',
      recommendedAction: 'CREATE',
      impact: 'high',
      confidenceBand: 'medium',
      limitedIntelligence: false,
    })
    expect(event.event).toBe(OPPORTUNITY_DETECTED_EVENT)
    expect(event.properties).toEqual({
      signal_type: 'competitor_coverage_gap',
      recommended_action: 'CREATE',
      impact: 'high',
      confidence: 'medium',
      limited_intelligence: false,
    })
  })

  it('opportunity_status_changed names the actor', () => {
    const event = opportunityStatusChanged(attribution, { from: 'new', to: 'dismissed', actor: 'user' })
    expect(event.event).toBe(OPPORTUNITY_STATUS_CHANGED_EVENT)
    expect(event.properties).toEqual({ from: 'new', to: 'dismissed', actor: 'user' })
  })

  it('every event carries the domain group, same as every other event in the product', () => {
    const event = opportunityDetected(attribution, {
      signalType: 'striking_distance',
      recommendedAction: 'OPTIMIZE',
      impact: 'medium',
      confidenceBand: 'high',
      limitedIntelligence: false,
    })
    expect(event.attribution).toBe(attribution)
  })
})

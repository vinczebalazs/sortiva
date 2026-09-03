import { describe, expect, it } from 'vitest'
import { rulesLayer } from '../signals/testing'
import {
  businessWeight,
  confidenceScore,
  createOpportunityScore,
  existingPageExpectedGain,
  fallbackMagnitude,
  percentileImpact,
} from './scoring'

const layer = rulesLayer()

describe('createOpportunityScore', () => {
  it('is log(volume) × winnability, times the pattern and source multipliers', () => {
    const base = createOpportunityScore(
      {
        monthlySearchVolume: 1000,
        winnability: 0.5,
        patternMultipliers: [],
        isCompetitorGapSourced: false,
        businessWeight: 1,
      },
      layer.scoring,
    )
    expect(base).toBeCloseTo(Math.log(1001) * 0.5, 10)
  })

  it('applies the competitor-gap source bonus only when asked', () => {
    const withoutBonus = createOpportunityScore(
      { monthlySearchVolume: 1000, winnability: 0.5, patternMultipliers: [], isCompetitorGapSourced: false, businessWeight: 1 },
      layer.scoring,
    )
    const withBonus = createOpportunityScore(
      { monthlySearchVolume: 1000, winnability: 0.5, patternMultipliers: [], isCompetitorGapSourced: true, businessWeight: 1 },
      layer.scoring,
    )
    expect(withBonus).toBeCloseTo(withoutBonus * layer.scoring.create.competitor_gap_source_bonus, 10)
  })

  it('never produces -Infinity or NaN for a pinned zero-volume topic', () => {
    const score = createOpportunityScore(
      { monthlySearchVolume: 0, winnability: 0.5, patternMultipliers: [], isCompetitorGapSourced: false, businessWeight: 1 },
      layer.scoring,
    )
    expect(Number.isFinite(score)).toBe(true)
    expect(score).toBe(0)
  })

  it('never produces -Infinity or NaN for a null volume', () => {
    const score = createOpportunityScore(
      { monthlySearchVolume: null, winnability: 0.5, patternMultipliers: [], isCompetitorGapSourced: false, businessWeight: 1 },
      layer.scoring,
    )
    expect(Number.isFinite(score)).toBe(true)
  })

  it('clamps the stacked pattern multiplier to [0.5, 2.0]', () => {
    const soaring = createOpportunityScore(
      { monthlySearchVolume: 1000, winnability: 1, patternMultipliers: [2, 2, 2], isCompetitorGapSourced: false, businessWeight: 1 },
      layer.scoring,
    )
    const atClamp = createOpportunityScore(
      { monthlySearchVolume: 1000, winnability: 1, patternMultipliers: [2], isCompetitorGapSourced: false, businessWeight: 1 },
      layer.scoring,
    )
    // Three stacked ×2s would be ×8 unclamped; both land at the same ×2.0 ceiling.
    expect(soaring).toBeCloseTo(atClamp, 10)
  })
})

describe('businessWeight', () => {
  it('rescales a 0–1 revenue share into [business_weight_min, business_weight_max]', () => {
    const { business_weight_min, business_weight_max } = layer.scoring.create
    expect(businessWeight(0, layer.scoring.create)).toBeCloseTo(business_weight_min, 10)
    expect(businessWeight(1, layer.scoring.create)).toBeCloseTo(business_weight_max, 10)
    expect(businessWeight(0.5, layer.scoring.create)).toBeCloseTo(
      (business_weight_min + business_weight_max) / 2,
      10,
    )
  })

  it('clamps a share outside 0–1', () => {
    expect(businessWeight(-1, layer.scoring.create)).toBeCloseTo(layer.scoring.create.business_weight_min, 10)
    expect(businessWeight(5, layer.scoring.create)).toBeCloseTo(layer.scoring.create.business_weight_max, 10)
  })
})

describe('existingPageExpectedGain', () => {
  it('is impressions × (target CTR − current CTR)', () => {
    expect(existingPageExpectedGain({ impressions: 1000, currentCtr: 0.02, targetCtr: 0.05 })).toBeCloseTo(30, 10)
  })

  it('floors at zero rather than going negative', () => {
    expect(existingPageExpectedGain({ impressions: 1000, currentCtr: 0.05, targetCtr: 0.02 })).toBe(0)
  })
})

describe('fallbackMagnitude', () => {
  it('reads the largest impressions-shaped fact', () => {
    const evidence = [
      { key: 'cluster_impressions', value: 250, source: 'gsc', fetchedAt: 'x' },
      { key: 'page_impressions', value: 900, source: 'gsc', fetchedAt: 'x' },
      { key: 'position', value: 4, source: 'gsc', fetchedAt: 'x' },
    ]
    expect(fallbackMagnitude(evidence)).toBe(900)
  })

  it('floors at 1 when nothing impressions-shaped exists', () => {
    expect(fallbackMagnitude([{ key: 'missing_fields', value: 'seo_title', source: 'content_inventory', fetchedAt: 'x' }])).toBe(1)
  })
})

describe('percentileImpact', () => {
  const config = layer.scoring.impact

  it('ranks the highest of a set at the top band', () => {
    // Midpoint tie handling (see DECISIONS) means the top of three lands at
    // 83, not a bare 100 — full credit for what's below it, half credit for
    // itself.
    const { impactScore, impact } = percentileImpact(30, [10, 20, 30], config)
    expect(impactScore).toBe(83)
    expect(impact).toBe('high')
  })

  it('ranks the lowest of a set near 0', () => {
    const { impactScore, impact } = percentileImpact(10, [10, 20, 30], config)
    expect(impactScore).toBeLessThan(config.band_tercile_low_max_percentile)
    expect(impact).toBe('low')
  })

  it('gives the sole candidate in an empty comparison set the top band', () => {
    expect(percentileImpact(5, [], config)).toEqual({ impactScore: 100, impact: 'high' })
  })

  it('splits ties down the middle rather than handing everyone the top band', () => {
    const { impactScore } = percentileImpact(10, [10, 10], config)
    expect(impactScore).toBe(50)
  })
})

describe('confidenceScore', () => {
  const scoring = layer.scoring.confidence

  it('adds points for GSC evidence, a long window, and no open precondition', () => {
    const evidence = [
      { key: 'position', value: 4, source: 'gsc', window: '28d', fetchedAt: 'x' },
    ]
    const { confidence, band } = confidenceScore(
      { evidence, preconditions: [], limitedIntelligence: false },
      scoring,
    )
    const expected =
      scoring.points.gsc_evidence_present +
      scoring.points.evidence_window_at_least_28_days +
      scoring.points.no_open_precondition
    expect(confidence).toBe(expected)
    expect(band).toBe(expected >= scoring.band_high_min ? 'high' : expected >= scoring.band_medium_min ? 'medium' : 'low')
  })

  it('applies the limited-intelligence penalty and never goes below the clamp floor', () => {
    const { confidence } = confidenceScore(
      { evidence: [], preconditions: ['x'], limitedIntelligence: true },
      scoring,
    )
    expect(confidence).toBeGreaterThanOrEqual(scoring.clamp_min)
    expect(confidence).toBe(scoring.clamp_min)
  })

  it('never exceeds the clamp ceiling', () => {
    const evidence = [
      { key: 'position', value: 4, source: 'gsc', window: '84d', fetchedAt: 'x' },
      { key: 'competitors', value: 2, source: 'dataforseo', fetchedAt: 'x' },
    ]
    const { confidence } = confidenceScore(
      {
        evidence,
        preconditions: [],
        limitedIntelligence: false,
        substanceFloorMargin: true,
        validatedAcrossConsecutiveScans: true,
      },
      scoring,
    )
    expect(confidence).toBeLessThanOrEqual(scoring.clamp_max)
  })

  it('bands high/medium/low at the configured cut-points', () => {
    expect(confidenceScore({ evidence: [], preconditions: [], limitedIntelligence: false }, scoring).band).toBe('low')
  })
})

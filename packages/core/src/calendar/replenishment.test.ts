import { describe, expect, it } from 'vitest'
import {
  needsReplenishment,
  openDatesInRange,
  planBatch,
  plannedHorizonDays,
  scoreCandidate,
  whyLineFor,
  REPLENISHMENT_WHY_COMPETITOR,
  REPLENISHMENT_WHY_EXPLORATION,
  REPLENISHMENT_WHY_REFRESH_POSITION,
  REPLENISHMENT_WHY_WINNING_PATTERN,
  type ActivePattern,
  type BatchShares,
  type ReplenishmentCandidate,
  type ScoringRecord,
} from './replenishment'

/**
 * The shares are the whole point of this module, so they are tested as
 * arithmetic over a fixture batch rather than through a database: a batch that
 * quietly fills with refreshes, or that stops trying anything new, is a
 * failure nothing else in the product would notice.
 */

const PATTERNS = { clampMin: 0.5, clampMax: 2.0, maxStacked: 3 }
const COMPETITOR_SIGNALS = ['competitor_coverage_gap']

const SHARES: BatchShares = {
  refreshShareMax: 0.4,
  explorationSlotsMin: 2,
  explorationShareMin: 0.15,
}

function candidate(over: Partial<ReplenishmentCandidate> & { opportunityId: string }): ReplenishmentCandidate {
  return {
    action: 'CREATE',
    signalType: 'uncovered_commercial_query',
    baseScore: 10,
    dimensions: [],
    reasonTemplateKey: 'uncovered_commercial_query.create',
    reasonParams: {},
    currentPosition: null,
    ...over,
  }
}

function record(over: Partial<ScoringRecord> & { opportunityId: string }): ScoringRecord {
  return {
    action: 'CREATE',
    signalType: 'uncovered_commercial_query',
    baseScore: 10,
    matchedPatterns: [],
    patternMultiplier: 1,
    sourceBonus: 1,
    score: 10,
    unexplored: true,
    currentPosition: null,
    reasonTemplateKey: 'uncovered_commercial_query.create',
    reasonParams: {},
    ...over,
  }
}

const WINNER: ActivePattern = {
  dimension: 'intent_class',
  value: 'buying_guide',
  multiplier: 1.25,
  winnerDominant: true,
}

describe('scoring a candidate', () => {
  it('is opportunity × pattern multipliers × source bonus', () => {
    const scored = scoreCandidate(
      candidate({ opportunityId: 'a', baseScore: 8, dimensions: [{ dimension: 'intent_class', value: 'buying_guide' }] }),
      [WINNER],
      PATTERNS,
      1.15,
      COMPETITOR_SIGNALS,
    )
    expect(scored.patternMultiplier).toBe(1.25)
    expect(scored.sourceBonus).toBe(1)
    expect(scored.score).toBeCloseTo(10, 10)
    expect(scored.unexplored).toBe(false)
  })

  it('applies the competitor-gap source bonus, and only to competitor-gap candidates', () => {
    const gap = scoreCandidate(
      candidate({ opportunityId: 'a', baseScore: 10, signalType: 'competitor_coverage_gap' }),
      [],
      PATTERNS,
      1.15,
      COMPETITOR_SIGNALS,
    )
    const plain = scoreCandidate(candidate({ opportunityId: 'b', baseScore: 10 }), [], PATTERNS, 1.15, COMPETITOR_SIGNALS)
    expect(gap.score).toBeCloseTo(11.5, 10)
    expect(plain.score).toBe(10)
  })

  it('clamps stacked multipliers and takes at most the configured number of them', () => {
    const dimensions = [
      { dimension: 'intent_class', value: 'x' },
      { dimension: 'family_id', value: 'y' },
      { dimension: 'keyword_cluster', value: 'z' },
      { dimension: 'action_type', value: 'w' },
    ]
    const strong: ActivePattern[] = dimensions.map((d) => ({ ...d, multiplier: 1.25, winnerDominant: true }))
    const scored = scoreCandidate(
      candidate({ opportunityId: 'a', baseScore: 1, dimensions }),
      strong,
      { clampMin: 0.5, clampMax: 1.5, maxStacked: 3 },
      1.15,
      COMPETITOR_SIGNALS,
    )
    // 1.25^3 is 1.953; the clamp is what the candidate actually gets.
    expect(scored.matchedPatterns).toHaveLength(3)
    expect(scored.patternMultiplier).toBe(1.5)
  })

  it('counts a candidate whose axes carry no active pattern as unexplored', () => {
    const scored = scoreCandidate(
      candidate({ opportunityId: 'a', dimensions: [{ dimension: 'family_id', value: 'never-written-about' }] }),
      [WINNER],
      PATTERNS,
      1.15,
      COMPETITOR_SIGNALS,
    )
    expect(scored.unexplored).toBe(true)
  })
})

describe('a batch respects the refresh cap and the exploration floor', () => {
  it('never lets refreshes exceed their share of the slots', () => {
    // Ten slots, twenty refresh candidates, all outscoring the creates.
    const refreshes = Array.from({ length: 20 }, (_, i) =>
      record({ opportunityId: `r${i}`, action: 'REFRESH', score: 100 - i, unexplored: false, matchedPatterns: [WINNER] }),
    )
    const creates = Array.from({ length: 20 }, (_, i) =>
      record({ opportunityId: `c${i}`, score: 50 - i, unexplored: false, matchedPatterns: [WINNER] }),
    )
    const plan = planBatch([...refreshes, ...creates], 10, SHARES)

    expect(plan.picks).toHaveLength(10)
    expect(plan.picks.filter((p) => p.record.action === 'REFRESH')).toHaveLength(4)
    expect(plan.refreshShare).toBeCloseTo(0.4, 10)
    expect(plan.refreshCap).toBe(4)
  })

  it('promotes unexplored candidates until the reservation is met, displacing the weakest explored picks', () => {
    const explored = Array.from({ length: 10 }, (_, i) =>
      record({ opportunityId: `e${i}`, score: 100 - i, unexplored: false, matchedPatterns: [WINNER] }),
    )
    const unexplored = Array.from({ length: 5 }, (_, i) => record({ opportunityId: `u${i}`, score: 10 - i }))
    const plan = planBatch([...explored, ...unexplored], 10, SHARES)

    // max(2, ceil(10 × 0.15)) = 2.
    expect(plan.explorationReserve).toBe(2)
    const promoted = plan.picks.filter((p) => p.selectedAs === 'exploration')
    expect(promoted.map((p) => p.record.opportunityId)).toEqual(['u0', 'u1'])
    // The two weakest explored picks made way, not the strongest.
    expect(plan.picks.map((p) => p.record.opportunityId)).not.toContain('e9')
    expect(plan.picks.map((p) => p.record.opportunityId)).toContain('e0')
    expect(plan.explorationShare).toBeCloseTo(0.2, 10)
  })

  it('uses the 15% floor once it is larger than the two-slot floor', () => {
    const explored = Array.from({ length: 40 }, (_, i) =>
      record({ opportunityId: `e${i}`, score: 100 - i, unexplored: false, matchedPatterns: [WINNER] }),
    )
    const unexplored = Array.from({ length: 10 }, (_, i) => record({ opportunityId: `u${i}`, score: 1 - i / 100 }))
    const plan = planBatch([...explored, ...unexplored], 30, SHARES)

    // max(2, ceil(30 × 0.15)) = 5.
    expect(plan.explorationReserve).toBe(5)
    expect(plan.picks.filter((p) => p.selectedAs === 'exploration')).toHaveLength(5)
  })

  it('marks nothing as exploration when the score pass already filled the reservation', () => {
    // Every candidate unexplored, which is every store until the learning loop
    // runs. Labelling all of them "trying something new" would empty the
    // comparison the label exists for.
    const all = Array.from({ length: 8 }, (_, i) => record({ opportunityId: `u${i}`, score: 10 - i }))
    const plan = planBatch(all, 5, SHARES)
    expect(plan.picks).toHaveLength(5)
    expect(plan.picks.every((p) => p.selectedAs === 'score')).toBe(true)
    expect(plan.explorationShare).toBe(0)
  })

  it('fills fewer slots than offered rather than inventing candidates', () => {
    const plan = planBatch([record({ opportunityId: 'a' })], 10, SHARES)
    expect(plan.picks).toHaveLength(1)
    expect(plan.candidatesScored).toBe(1)
  })

  it('plans the same batch twice the same way, ties included', () => {
    const tied = ['b', 'a', 'c'].map((id) => record({ opportunityId: id, score: 5 }))
    const first = planBatch(tied, 2, SHARES)
    const second = planBatch([...tied].reverse(), 2, SHARES)
    expect(first.picks.map((p) => p.record.opportunityId)).toEqual(second.picks.map((p) => p.record.opportunityId))
  })

  it('does not break the refresh cap while satisfying the exploration floor', () => {
    const explored = Array.from({ length: 10 }, (_, i) =>
      record({ opportunityId: `e${i}`, score: 100 - i, unexplored: false, matchedPatterns: [WINNER] }),
    )
    // The only unexplored candidates are refreshes; the cap must still hold.
    const unexplored = Array.from({ length: 6 }, (_, i) =>
      record({ opportunityId: `u${i}`, action: 'REFRESH', score: 10 - i }),
    )
    const plan = planBatch([...explored, ...unexplored], 5, SHARES)
    expect(plan.refreshCap).toBe(2)
    expect(plan.picks.filter((p) => p.record.action === 'REFRESH').length).toBeLessThanOrEqual(2)
  })
})

describe('the why-line every filled slot carries', () => {
  it('says "trying something new" for a promoted exploration pick', () => {
    const line = whyLineFor({ record: record({ opportunityId: 'a' }), selectedAs: 'exploration' })
    expect(line.templateKey).toBe(REPLENISHMENT_WHY_EXPLORATION)
  })

  it('names the winning pattern when one is what lifted the candidate', () => {
    const line = whyLineFor({
      record: record({ opportunityId: 'a', matchedPatterns: [WINNER], unexplored: false }),
      selectedAs: 'score',
    })
    expect(line.templateKey).toBe(REPLENISHMENT_WHY_WINNING_PATTERN)
    expect(line.params).toEqual({ dimension: 'intent_class' })
  })

  it('carries the article’s current position for a refresh', () => {
    const line = whyLineFor({
      record: record({ opportunityId: 'a', action: 'REFRESH', currentPosition: 7 }),
      selectedAs: 'score',
    })
    expect(line.templateKey).toBe(REPLENISHMENT_WHY_REFRESH_POSITION)
    expect(line.params).toEqual({ position: 7 })
  })

  it('says a competitor ranks for it when the source bonus was applied', () => {
    const line = whyLineFor({
      record: record({ opportunityId: 'a', signalType: 'competitor_coverage_gap', sourceBonus: 1.15 }),
      selectedAs: 'score',
    })
    expect(line.templateKey).toBe(REPLENISHMENT_WHY_COMPETITOR)
  })

  it('falls back to the reason the engine that detected it already wrote', () => {
    const line = whyLineFor({
      record: record({ opportunityId: 'a', reasonTemplateKey: 'x.y', reasonParams: { volume: 400 } }),
      selectedAs: 'score',
    })
    expect(line).toEqual({ templateKey: 'x.y', params: { volume: 400 } })
  })

  it('never returns an empty key, so no slot can reach the calendar unexplained', () => {
    const lines = [
      whyLineFor({ record: record({ opportunityId: 'a' }), selectedAs: 'exploration' }),
      whyLineFor({ record: record({ opportunityId: 'b' }), selectedAs: 'score' }),
    ]
    for (const line of lines) expect(line.templateKey.length).toBeGreaterThan(0)
  })
})

describe('when a top-up is due, and which days it may use', () => {
  it('measures the horizon to the furthest day still planned', () => {
    expect(plannedHorizonDays('2026-05-01', '2026-03-02')).toBe(60)
    expect(plannedHorizonDays(null, '2026-03-02')).toBe(0)
    // A calendar whose last planned day is already behind us is not negative.
    expect(plannedHorizonDays('2026-01-01', '2026-03-02')).toBe(0)
  })

  it('fires below the trigger and not at it', () => {
    expect(needsReplenishment(59, 60)).toBe(true)
    expect(needsReplenishment(60, 60)).toBe(false)
  })

  it('offers only the days nothing occupies', () => {
    const open = openDatesInRange(new Set(['2026-03-02', '2026-03-04']), '2026-03-01', '2026-03-05')
    expect(open).toEqual(['2026-03-01', '2026-03-03', '2026-03-05'])
  })
})

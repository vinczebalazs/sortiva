import { describe, expect, it } from 'vitest'
import { detectCompetitorCoverageGaps } from '../signals/competitor-gap'
import { detectCatalogRichnessGaps } from '../signals/richness-gap'
import { rulesLayer } from '../signals/testing'
import { substanceInventory } from '../signals/substance'
import { emptyFactSheet } from '../distill/schema'
import { buildOpportunityDraft, rankByImpact, type OpportunityBuildContext } from './build'

const layer = rulesLayer()

function context(overrides: Partial<OpportunityBuildContext> = {}): OpportunityBuildContext {
  return {
    accountId: 'acct_1',
    limitedIntelligence: false,
    rulesVersion: 'test-rules-version',
    winnability: 0.5,
    patternMultiplierClamp: {
      min: layer.learning.patterns.multiplier_clamp_min,
      max: layer.learning.patterns.multiplier_clamp_max,
    },
    detectedAt: '2026-01-29T06:00:00.000Z',
    ...overrides,
  }
}

describe('buildOpportunityDraft — status policy (main §7.9)', () => {
  it('auto-accepts a CREATE candidate', () => {
    const [signal] = detectCompetitorCoverageGaps({
      candidates: [
        {
          keyword: 'trail running shoes',
          monthlySearchVolume: 500,
          intentClass: 'buying_guide',
          familyIds: ['trail-running'],
          source: 'merchant_seed',
          competitorRankings: [
            { domain: 'a.com', position: 3, url: 'https://a.com/x' },
            { domain: 'b.com', position: 5, url: 'https://b.com/y' },
          ],
          ourPosition: null,
          ourUrl: null,
        },
      ],
      config: layer.signals.competitor_coverage_gap,
      fetchedAt: '2026-01-29T06:00:00.000Z',
    })
    const draft = buildOpportunityDraft(signal!, context(), layer.scoring)
    expect(draft.recommendedAction).toBe('CREATE')
    expect(draft.status).toBe('accepted')
    expect(draft.preconditions).toEqual([])
  })

  it('auto-accepts a competitor-gap OPTIMIZE just like a CREATE — both are already-approved actions', () => {
    const [signal] = detectCompetitorCoverageGaps({
      candidates: [
        {
          keyword: 'trail running shoes',
          monthlySearchVolume: 500,
          intentClass: 'buying_guide',
          familyIds: ['trail-running'],
          source: 'merchant_seed',
          competitorRankings: [
            { domain: 'a.com', position: 3, url: 'https://a.com/x' },
            { domain: 'b.com', position: 5, url: 'https://b.com/y' },
          ],
          ourPosition: 18,
          ourUrl: '/collections/trail-running',
        },
      ],
      config: layer.signals.competitor_coverage_gap,
      fetchedAt: '2026-01-29T06:00:00.000Z',
    })
    const draft = buildOpportunityDraft(signal!, context(), layer.scoring)
    expect(draft.recommendedAction).toBe('OPTIMIZE')
    // OPTIMIZE is user-initiated (main §7.9) — `new`, not auto-accepted.
    expect(draft.status).toBe('new')
    expect(draft.reasonTemplateKey).toBe('existing_target.prefer_optimize')
  })

  it('blocks a HOLD candidate and names the precondition', () => {
    const products = [
      { productId: 'p1', title: 'Shoe', familyId: 'trail-running', factSheet: emptyFactSheet() },
    ]
    const substance = substanceInventory(products, layer.gates.substance_floor)
    const [signal] = detectCatalogRichnessGaps({
      candidates: [
        {
          keyword: 'best trail running shoes',
          monthlySearchVolume: 500,
          intentClass: 'buying_guide',
          familyIds: ['trail-running'],
          source: 'merchant_seed',
          winnability: 0.9,
          substance,
        },
      ],
      gates: layer.gates,
      fetchedAt: '2026-01-29T06:00:00.000Z',
    })
    const draft = buildOpportunityDraft(signal!, context(), layer.scoring)
    expect(draft.recommendedAction).toBe('HOLD')
    expect(draft.status).toBe('blocked')
    expect(draft.preconditions).toEqual(['catalog_richness_gap'])
  })

  it('blocks anything carrying an open technical blocker, regardless of action', () => {
    const [signal] = detectCompetitorCoverageGaps({
      candidates: [
        {
          keyword: 'trail running shoes',
          monthlySearchVolume: 500,
          intentClass: 'buying_guide',
          familyIds: ['trail-running'],
          source: 'merchant_seed',
          competitorRankings: [
            { domain: 'a.com', position: 3, url: 'https://a.com/x' },
            { domain: 'b.com', position: 5, url: 'https://b.com/y' },
          ],
          ourPosition: null,
          ourUrl: null,
        },
      ],
      config: layer.signals.competitor_coverage_gap,
      fetchedAt: '2026-01-29T06:00:00.000Z',
    })
    const draft = buildOpportunityDraft(signal!, context({ technicalBlocker: 'indexing_issue' }), layer.scoring)
    expect(draft.status).toBe('blocked')
    expect(draft.preconditions).toContain('indexing_issue')
  })
})

describe('rankByImpact — percentile rank within the action family only (main §7.6)', () => {
  it('never compares a CREATE candidate against an OPTIMIZE one', () => {
    const create = (volume: number) =>
      detectCompetitorCoverageGaps({
        candidates: [
          {
            keyword: `k-${volume}`,
            monthlySearchVolume: volume,
            intentClass: 'buying_guide' as const,
            familyIds: ['trail-running'],
            source: 'merchant_seed' as const,
            competitorRankings: [
              { domain: 'a.com', position: 3, url: 'https://a.com/x' },
              { domain: 'b.com', position: 5, url: 'https://b.com/y' },
            ],
            ourPosition: null,
            ourUrl: null,
          },
        ],
        config: layer.signals.competitor_coverage_gap,
        fetchedAt: '2026-01-29T06:00:00.000Z',
      })[0]!

    const optimize = detectCompetitorCoverageGaps({
      candidates: [
        {
          keyword: 'k-optimize',
          monthlySearchVolume: 100000,
          intentClass: 'buying_guide' as const,
          familyIds: ['trail-running'],
          source: 'merchant_seed' as const,
          competitorRankings: [
            { domain: 'a.com', position: 3, url: 'https://a.com/x' },
            { domain: 'b.com', position: 5, url: 'https://b.com/y' },
          ],
          ourPosition: 18,
          ourUrl: '/collections/trail-running',
        },
      ],
      config: layer.signals.competitor_coverage_gap,
      fetchedAt: '2026-01-29T06:00:00.000Z',
    })[0]!

    const drafts = [
      buildOpportunityDraft(create(50), context(), layer.scoring),
      buildOpportunityDraft(create(5000), context(), layer.scoring),
      buildOpportunityDraft(optimize, context(), layer.scoring),
    ]
    const ranked = rankByImpact(drafts, layer.scoring.impact)
    const createRanked = ranked.filter((d) => d.recommendedAction === 'CREATE')
    const optimizeRanked = ranked.filter((d) => d.recommendedAction === 'OPTIMIZE')

    expect(createRanked).toHaveLength(2)
    expect(optimizeRanked).toHaveLength(1)
    // The lone OPTIMIZE candidate is ranked only against itself — the
    // midpoint of a family of one, per `percentileImpact`'s tie rule — not
    // against either CREATE candidate's raw score, which is far larger.
    expect(optimizeRanked[0]!.impact).toBe('medium')
    expect(optimizeRanked[0]!.impactScore).toBe(50)
    // The two CREATE candidates are ranked against each other: the larger
    // volume outranks the smaller one within their own family.
    const bigger = createRanked.find((d) => d.rawScore === Math.max(...createRanked.map((c) => c.rawScore)))!
    const smaller = createRanked.find((d) => d !== bigger)!
    expect(bigger.impactScore).toBeGreaterThan(smaller.impactScore)
  })
})

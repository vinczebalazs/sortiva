import { describe, expect, it } from 'vitest'
import { rulesLayer } from '../signals/testing'
import { toContractOpportunity, type StoredOpportunity } from './contract-mapping'

const layer = rulesLayer()

function row(overrides: Partial<StoredOpportunity> = {}): StoredOpportunity {
  return {
    id: 'opp_1',
    accountId: 'acct_1',
    signalType: 'competitor_coverage_gap',
    entityType: 'url',
    entityRef: '/collections/trail-running',
    evidenceJson: [{ key: 'x', value: 1, source: 'gsc', fetchedAt: 'x' }],
    impact: 'high',
    impactScore: 90,
    confidence: 75,
    reasonTemplateKey: 'competitor_coverage_gap.create',
    reasonParamsJson: { competitors: 2 },
    recommendedAction: 'create',
    preconditionsJson: [],
    status: 'accepted',
    rulesVersion: 'test-rules-version',
    limitedIntelligence: false,
    detectedAt: '2026-01-29T06:00:00.000Z',
    updatedAt: '2026-01-29T06:00:00.000Z',
    expiredReason: null,
    ...overrides,
  }
}

describe('toContractOpportunity', () => {
  it('translates the database entity_type "url" into the contract\'s "page"', () => {
    const opp = toContractOpportunity(row({ entityType: 'url' }), layer.scoring.confidence)
    expect(opp.entityRef.kind).toBe('page')
  })

  it('passes the other four entity types through unchanged', () => {
    for (const kind of ['query_cluster', 'family', 'article', 'product'] as const) {
      expect(toContractOpportunity(row({ entityType: kind }), layer.scoring.confidence).entityRef.kind).toBe(kind)
    }
  })

  it('uppercases the stored lowercase action', () => {
    expect(toContractOpportunity(row({ recommendedAction: 'optimize' }), layer.scoring.confidence).recommendedAction).toBe('OPTIMIZE')
  })

  it('derives the confidence band from the integer at read time, using the same cut-points scoring used', () => {
    const high = toContractOpportunity(row({ confidence: layer.scoring.confidence.band_high_min }), layer.scoring.confidence)
    expect(high.confidence).toBe('high')
    const low = toContractOpportunity(row({ confidence: 0 }), layer.scoring.confidence)
    expect(low.confidence).toBe('low')
  })

  it('the entity label falls back to the raw entity_ref, which is all the row holds', () => {
    const opp = toContractOpportunity(row({ entityRef: 'best trail running shoes' }), layer.scoring.confidence)
    expect(opp.entityRef.id).toBe('best trail running shoes')
    expect(opp.entityRef.label).toBe('best trail running shoes')
  })
})

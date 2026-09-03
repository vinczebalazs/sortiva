import type { ScoringConfig } from '@sortiva/rules'
import type {
  ConfidenceBand,
  EntityRef,
  EvidenceFact,
  ImpactBand,
  Opportunity,
  OpportunityAction,
  OpportunityStatus,
} from '../contracts/opportunities'

/**
 * The stored row, in the shape a database read gives it — plain fields, no
 * drizzle types. Kept independent of `@sortiva/db`'s inferred row type on
 * purpose: `packages/core` has no dependency on the database package (the same
 * discipline that keeps it free of Next, React and provider SDKs), so a caller
 * holding a real row narrows or spreads it into this shape rather than this
 * module importing one.
 */
/**
 * `opportunities.entity_type`'s own enum (schema wave 2, T2.0) uses `url`;
 * the frozen `EntityRef` contract (T0.7, frozen before the schema landed)
 * uses `page` for the same idea. Two already-shipped shapes disagreeing —
 * this module is where the table's word is translated to the contract's,
 * per DECISIONS 2026-08-31 T0.7 ("where the table and the contract differ,
 * the table is authoritative and the producing card maps").
 */
export type StoredEntityType = 'query_cluster' | 'url' | 'family' | 'article' | 'product'

export interface StoredOpportunity {
  readonly id: string
  readonly accountId: string
  readonly signalType: string
  readonly entityType: StoredEntityType
  readonly entityRef: string
  readonly evidenceJson: unknown
  readonly impact: ImpactBand
  readonly impactScore: number
  /** The 0–100 integer only — main §7.6/DECISIONS 2026-08-31 T0.7: no band column exists, so the band is derived here, at read time, from the same config that would have produced it originally. */
  readonly confidence: number
  readonly reasonTemplateKey: string
  readonly reasonParamsJson: unknown
  readonly recommendedAction: 'create' | 'optimize' | 'refresh' | 'fix' | 'hold'
  readonly preconditionsJson: unknown
  readonly status: OpportunityStatus
  readonly rulesVersion: string
  readonly limitedIntelligence: boolean
  readonly detectedAt: Date | string
  readonly updatedAt: Date | string
  readonly expiredReason: string | null
}

const UPPERCASE_ACTION: Readonly<Record<StoredOpportunity['recommendedAction'], OpportunityAction>> = {
  create: 'CREATE',
  optimize: 'OPTIMIZE',
  refresh: 'REFRESH',
  fix: 'FIX',
  hold: 'HOLD',
}

function isoOf(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString()
}

function confidenceBandOf(confidence: number, config: ScoringConfig['confidence']): ConfidenceBand {
  if (confidence >= config.band_high_min) return 'high'
  if (confidence >= config.band_medium_min) return 'medium'
  return 'low'
}

const ENTITY_KIND: Readonly<Record<StoredEntityType, EntityRef['kind']>> = {
  query_cluster: 'query_cluster',
  url: 'page',
  family: 'family',
  article: 'article',
  product: 'product',
}

/**
 * A stored row, as the frozen cross-lane `Opportunity` contract speaks it.
 * `entityRef.label` is the raw `entity_ref` string itself: the row holds
 * nothing richer (a page title, a keyword's original casing) to build a nicer
 * one from, so a caller wanting that resolves it from the entity's own table
 * (`store_pages`, `keywords`, …) and overwrites the field.
 */
export function toContractOpportunity(row: StoredOpportunity, confidenceConfig: ScoringConfig['confidence']): Opportunity {
  return {
    id: row.id,
    accountId: row.accountId,
    signalType: row.signalType,
    entityRef: { kind: ENTITY_KIND[row.entityType], id: row.entityRef, label: row.entityRef },
    recommendedAction: UPPERCASE_ACTION[row.recommendedAction],
    status: row.status,
    impactScore: row.impactScore,
    impact: row.impact,
    confidenceScore: row.confidence,
    confidence: confidenceBandOf(row.confidence, confidenceConfig),
    evidence: (row.evidenceJson ?? []) as readonly EvidenceFact[],
    reasonTemplateKey: row.reasonTemplateKey,
    reasonParams: (row.reasonParamsJson ?? {}) as Readonly<Record<string, string | number>>,
    preconditions: (row.preconditionsJson ?? []) as readonly string[],
    rulesVersion: row.rulesVersion,
    limitedIntelligence: row.limitedIntelligence,
    detectedAt: isoOf(row.detectedAt),
  }
}

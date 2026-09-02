/**
 * The two response bodies the Opportunities screen reads, written out here
 * rather than derived from the API's schemas.
 *
 * The schemas are the contract; this is one consumer's view of it. Keeping the
 * view separate is what lets a component be rendered in a test with three
 * hand-made rows and no zod, and it is why nothing under `packages/ui` needs a
 * validation library in the browser bundle. What stops the two drifting is the
 * screen contract beside this folder: every field named below is registered
 * there, and a test asserts each one still resolves in the mock fixtures the
 * schemas validate.
 */

export const OPPORTUNITY_ACTIONS = ['CREATE', 'OPTIMIZE', 'REFRESH', 'FIX', 'HOLD'] as const
export type OpportunityAction = (typeof OPPORTUNITY_ACTIONS)[number]

export type OpportunityStatus =
  | 'new'
  | 'accepted'
  | 'scheduled'
  | 'executing'
  | 'completed'
  | 'dismissed'
  | 'blocked'
  | 'expired'

export type ImpactBand = 'high' | 'medium' | 'low'
export type ConfidenceBand = 'high' | 'medium' | 'low'
export type EntityKind = 'query_cluster' | 'page' | 'product' | 'family' | 'article'

/** A sentence the engine chose and we own the words of. Never model output. */
export interface TemplatedLine {
  readonly templateKey: string
  readonly params: Readonly<Record<string, string | number>>
}

/** One measured fact, with where it came from and over what period. */
export interface EvidenceFact {
  readonly key: string
  readonly value: string | number
  readonly source: string
  readonly window?: string
  readonly fetchedAt: string
}

export interface EntityRef {
  readonly kind: EntityKind
  readonly id: string
  readonly label: string
}

export interface ConfidenceFactor {
  readonly label: string
  readonly direction: 'up' | 'down'
}

export interface Precondition {
  readonly code: string
  readonly whatToDo: TemplatedLine
}

export interface OpportunityRow {
  readonly id: string
  readonly signalType: string
  readonly entityRef: EntityRef
  readonly recommendedAction: OpportunityAction
  readonly status: OpportunityStatus
  readonly impact: ImpactBand
  readonly impactScore: number
  readonly confidence: ConfidenceBand
  readonly confidenceScore: number
  readonly confidenceFactors: readonly ConfidenceFactor[]
  readonly evidence: readonly EvidenceFact[]
  readonly why: TemplatedLine
  readonly preconditions: readonly Precondition[]
  readonly rulesVersion: string
  readonly limitedIntelligence: boolean
  readonly detectedAt: string
  readonly scheduledFor: string | null
  readonly expiresAt: string | null
}

export interface OpportunityListResponse {
  readonly opportunities: readonly OpportunityRow[]
  readonly counts: {
    readonly open: number
    readonly byAction: Partial<Record<OpportunityAction, number>>
  }
  readonly lastScanAt: string | null
  readonly nextScanAt: string | null
  readonly limitedIntelligence: boolean
  readonly cursor: string | null
}

export interface OpportunityTask {
  readonly id: string
  readonly label: string
  readonly state: 'open' | 'applied' | 'skipped'
}

export interface RecommendationField {
  readonly field: string
  readonly current: string | null
  readonly suggested: string
  readonly evidence: string | null
}

export interface Recommendation {
  readonly state: 'none' | 'generating' | 'ready' | 'failed_validation'
  readonly fields: readonly RecommendationField[]
  readonly internalLinksIn: readonly { readonly fromUrl: string; readonly anchor: string }[]
  readonly internalLinksOut: readonly { readonly toUrl: string; readonly anchor: string }[]
  readonly intentNote: string | null
  readonly failureReason: TemplatedLine | null
}

export interface HistoryEntry {
  readonly at: string
  readonly from: OpportunityStatus | null
  readonly to: OpportunityStatus
  readonly actor: 'user' | 'autopilot' | 'expiry'
  readonly reason: TemplatedLine | null
}

export interface OpportunityOutcome {
  readonly label: string
  readonly measuredAt: string
  readonly before: number
  readonly after: number
}

export interface OpportunityDetail {
  readonly opportunity: OpportunityRow
  readonly tasks: readonly OpportunityTask[]
  readonly serpSnapshot:
    | readonly { readonly position: number; readonly domain: string; readonly url: string }[]
    | null
  readonly recommendation: Recommendation | null
  readonly history: readonly HistoryEntry[]
  readonly outcome: OpportunityOutcome | null
}

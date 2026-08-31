import type { EventAttribution } from './analytics'

/**
 * The vocabulary the Opportunity Engine's seams speak (main §7). Declared here
 * rather than in Lane C's package so the contracts below — and the API schemas —
 * can name these types before the engine exists.
 *
 * These are **contract types**, not the `opportunities` table (schema wave 2,
 * T2.0). Where the two differ, the table is authoritative and its card maps to
 * this shape at the seam.
 */

/** main §7.4 — the action catalog. */
export const OPPORTUNITY_ACTIONS = ['CREATE', 'OPTIMIZE', 'REFRESH', 'FIX', 'HOLD'] as const
export type OpportunityAction = (typeof OPPORTUNITY_ACTIONS)[number]

/** main §7.9 — `new → accepted → scheduled → executing → completed | dismissed | blocked | expired`. */
export const OPPORTUNITY_STATUSES = [
  'new',
  'accepted',
  'scheduled',
  'executing',
  'completed',
  'dismissed',
  'blocked',
  'expired',
] as const
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number]

export const IMPACT_BANDS = ['high', 'medium', 'low'] as const
export type ImpactBand = (typeof IMPACT_BANDS)[number]

export const CONFIDENCE_BANDS = ['high', 'medium', 'low'] as const
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number]

/** main §8.7 — the article template an intent class selects. */
export const INTENT_CLASSES = ['buying_guide', 'comparison', 'how_to', 'informational'] as const
export type IntentClass = (typeof INTENT_CLASSES)[number]

/**
 * main §7.6 — "Every opportunity row has evidence (with source + window per
 * fact)". The source and window are not decoration: the UI renders them on the
 * card ("Search Console, last 28 days"), and a fact without them cannot be shown.
 */
export interface EvidenceFact {
  readonly key: string
  readonly value: string | number
  /** Where the number came from — `gsc`, `dataforseo`, `catalog`, `content_inventory`. */
  readonly source: string
  /** The observation window, e.g. `28d`. Absent for facts that are not time-bounded. */
  readonly window?: string
  readonly fetchedAt: string
}

/**
 * main §7.9 — the dedupe key. The partial unique index is on
 * `(account_id, signal_type, entity_ref)`, so an entity reference is part of a
 * signal's identity, not a display field.
 */
export interface EntityRef {
  readonly kind: 'query_cluster' | 'page' | 'product' | 'family' | 'article'
  readonly id: string
  /** Human-readable, for the card title. */
  readonly label: string
}

export interface Opportunity {
  readonly id: string
  readonly accountId: string
  readonly signalType: string
  readonly entityRef: EntityRef
  readonly recommendedAction: OpportunityAction
  readonly status: OpportunityStatus
  readonly impactScore: number
  readonly impact: ImpactBand
  readonly confidenceScore: number
  readonly confidence: ConfidenceBand
  readonly evidence: readonly EvidenceFact[]
  /** main §7.1, invariant 8 — the why-line renders from this key, never from an LLM. */
  readonly reasonTemplateKey: string
  /** Values the template interpolates. Numbers and ids only. */
  readonly reasonParams: Readonly<Record<string, string | number>>
  /** main §7.9 — an open precondition; the card renders a blocked ribbon. */
  readonly preconditions: readonly string[]
  /** main §7.10 — the hash of `signals.config.yaml` that produced this row. */
  readonly rulesVersion: string
  /** main §7.11 — produced without Search Console data. */
  readonly limitedIntelligence: boolean
  readonly detectedAt: string
  readonly expiresAt?: string
}

/**
 * main §7.7 — "The existing-target check (mandatory before any CREATE) … the
 * single most important rule in the merge". Invariant 6: Gate 1's
 * cannibalisation check and §7.7 are the *same function*, and a match converts
 * to OPTIMIZE or REFRESH — never a competing URL.
 */
export interface QueryCluster {
  /** The head term the cluster is named by. */
  readonly head: string
  /** The related-keyword expansion (main §9.6.3). */
  readonly members: readonly string[]
  readonly intentClass: IntentClass
  /** Product families this cluster maps to (main §6.4). */
  readonly familyIds: readonly string[]
}

export type ExistingTargetOutcome =
  | { readonly match: 'none' }
  /** §7.7.3 — a real match. CREATE must not proceed; this becomes OPTIMIZE or REFRESH. */
  | {
      readonly match: 'strong'
      readonly url: string
      readonly action: 'OPTIMIZE' | 'REFRESH'
      /** Which of §7.7's three lookups found it: `gsc`, `content_mapping`, `limited_intelligence`. */
      readonly via: 'gsc' | 'content_mapping' | 'limited_intelligence'
      readonly position?: number
    }
  /**
   * §7.7.4 — "If the match is weak (position > 30, or a product page for a
   * category-level intent), CREATE may proceed **only** with the existing URL
   * recorded in `evidence.existing_target` and an internal-linking task
   * attached". The caller must honour both halves.
   */
  | {
      readonly match: 'weak'
      readonly url: string
      readonly action: 'CREATE_WITH_LINK'
      readonly via: 'gsc' | 'content_mapping' | 'limited_intelligence'
      readonly position?: number
    }

export interface ExistingTargetCheck {
  check(cluster: QueryCluster, accountId: string): Promise<ExistingTargetOutcome>
}

/**
 * Build plan §4 — Lane C produces accepted content opportunities; Lane D's
 * replenishment and calendar seeding consume them.
 */
export interface OpportunitySource {
  /** main §7.9 — CREATE and REFRESH are auto-accepted under the V1 autopilot policy. */
  acceptedContentOpportunities(accountId: string): Promise<readonly Opportunity[]>
}

/** Build plan §4 — Lane D produces the scheduler; Lane C's onboarding run seeds the calendar. */
export interface ScheduledTopic {
  readonly topicId: string
  readonly opportunityId: string
  /** ISO date (no time): the calendar is a date grid (main §8.7). */
  readonly scheduledFor: string
  readonly title: string
  readonly state: 'planned' | 'checking' | 'generating' | 'in_review' | 'published' | 'rejected_by_gate' | 'vetoed'
}

export interface TopicScheduler {
  /**
   * main §8.7 — "picks the next open calendar day by default; a date picker
   * allows any future day". A pinned occupant is never displaced.
   */
  schedule(opportunity: Opportunity, date?: string): Promise<ScheduledTopic>
}

/**
 * Build plan §4 — Lane D's judge, reused by Lane E to grade OPTIMIZE
 * recommendations. Invariant 11: the judge is a separate call, blind to the
 * writer's context, and **never** run on a smaller model.
 */
export interface JudgeScores {
  readonly informationGain: number
  readonly factualGrounding: number
  readonly [criterion: string]: number
}

export interface JudgeVerdict {
  readonly passed: boolean
  readonly scores: JudgeScores
  /** Plain-language justification per criterion; rendered on the §8.6 rejection card. */
  readonly justifications: Readonly<Record<string, string>>
  readonly promptVersion: string
  readonly modelId: string
}

export interface JudgeLite {
  grade(recommendation: unknown, pack: unknown): Promise<JudgeVerdict>
}

/**
 * Build plan §4 — Lane B's product/collection change stream, consumed by Lane
 * C's content inventory and Lane D's drift detection (main §14.1).
 */
export interface CatalogEvent {
  readonly accountId: string
  readonly kind:
    | 'product_created'
    | 'product_updated'
    | 'product_deleted'
    | 'collection_updated'
    | 'price_changed'
    | 'availability_changed'
  readonly entityId: string
  /** main §14.3.8 — out-of-order delivery is normal; consumers compare this. */
  readonly occurredAt: string
  readonly changedFields: readonly string[]
}

export interface CatalogEvents {
  since(accountId: string, cursor?: string): Promise<{ events: readonly CatalogEvent[]; cursor: string }>
}

/**
 * tech §1.2 — notifications are append-only records with a unique
 * `(account_id, type, dedupe_key)`; every lane emits at its own points.
 * Invariant 26.
 */
export const NOTIFICATION_TYPES = [
  'ingestion_review_ready',
  'opportunities_ready',
  'new_opportunities_found',
  'optimize_recommendation_ready',
  'merchant_task_created',
  'article_published',
  'draft_ready_for_review',
  'topic_held_by_gate',
  'repair_needed',
  'connection_lost_shopify',
  'connection_lost_gsc',
  'payment_failed',
  'monthly_summary_ready',
  'export_url_reminder',
  'oauth_reminder',
] as const

export type NotificationType = (typeof NOTIFICATION_TYPES)[number]

export interface NotificationEmitter {
  /**
   * tech §1.2 — `refs` holds **references only** (topic_id, article_id,
   * opportunity_id …). Display text is produced at render time, so a copy fix
   * never requires touching stored rows.
   */
  emit(
    type: NotificationType,
    refs: Readonly<Record<string, string>>,
    dedupeKey: string,
    attribution: EventAttribution,
  ): Promise<{ created: boolean }>
}

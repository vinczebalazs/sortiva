import type { EventAttribution } from './analytics'

/**
 * The vocabulary the Opportunity Engine's seams speak. Declared here
 * rather than in Lane C's package so the contracts below — and the API schemas —
 * can name these types before the engine exists.
 *
 * These are **contract types**, not the `opportunities` table (schema wave 2,
 * T2.0). Where the two differ, the table is authoritative and its card maps to
 * this shape at the seam.
 */

/** Everything we can propose doing about an opportunity. */
export const OPPORTUNITY_ACTIONS = ['CREATE', 'OPTIMIZE', 'REFRESH', 'FIX', 'HOLD'] as const
export type OpportunityAction = (typeof OPPORTUNITY_ACTIONS)[number]

/** An opportunity's lifecycle: `new → accepted → scheduled → executing → completed | dismissed | blocked | expired`. */
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

/** The article template an intent class selects. */
export const INTENT_CLASSES = ['buying_guide', 'comparison', 'how_to', 'informational'] as const
export type IntentClass = (typeof INTENT_CLASSES)[number]

/**
 * One fact behind an opportunity. The source and window are not decoration:
 * the UI renders them on the card ("Search Console, last 28 days"), and a fact
 * that cannot say where it came from or over what period cannot be shown at
 * all.
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
 * What an opportunity is *about*. The open-opportunity unique index is on
 * `(account_id, signal_type, entity_ref)`, so this is part of a signal's
 * identity rather than a display field — get it wrong and re-detection creates
 * a duplicate instead of updating the row.
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
  /** The why-line renders from this key and the record around it. No LLM ever writes a reason the merchant reads. */
  readonly reasonTemplateKey: string
  /** Values the template interpolates. Numbers and ids only. */
  readonly reasonParams: Readonly<Record<string, string | number>>
  /** Something that must be resolved first; while it is open the card renders a blocked ribbon. */
  readonly preconditions: readonly string[]
  /** The hash of `signals.config.yaml` that produced this row, so a result can always be traced to the numbers behind it. */
  readonly rulesVersion: string
  /** Produced without Search Console data, so it rests on inference rather than measurement. */
  readonly limitedIntelligence: boolean
  readonly detectedAt: string
  readonly expiresAt?: string
}

/**
 * The existing-target check runs before any CREATE and is the same function as
 * the cannibalization check — deliberately, so the two can never disagree. A
 * match converts the work to OPTIMIZE or REFRESH; it never results in a second
 * page of ours competing with the first.
 */
export interface QueryCluster {
  /** The head term the cluster is named by. */
  readonly head: string
  /** The related keywords the head term expands to. */
  readonly members: readonly string[]
  readonly intentClass: IntentClass
  /** Product families this cluster maps to. */
  readonly familyIds: readonly string[]
}

export type ExistingTargetOutcome =
  | { readonly match: 'none' }
  /** A real match. CREATE must not proceed; this becomes OPTIMIZE or REFRESH. */
  | {
      readonly match: 'strong'
      readonly url: string
      readonly action: 'OPTIMIZE' | 'REFRESH'
      /** Which of the three lookups found it: Search Console data, our own content mapping, or the no-GSC fallback. */
      readonly via: 'gsc' | 'content_mapping' | 'limited_intelligence'
      readonly position?: number
    }
  /**
   * A weak match — the page ranks badly, or it is a product page for a
   * category-level query. CREATE may proceed, but **only** with the existing
   * URL recorded in the evidence and an internal-linking task attached. The
   * caller must honour both halves; doing one without the other leaves us with
   * two pages and nothing tying them together.
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
 * Lane C produces accepted content opportunities; Lane D's replenishment and
 * calendar seeding consume them.
 */
export interface OpportunitySource {
  /** CREATE and REFRESH are auto-accepted: V1 runs on autopilot, so these need no merchant approval. */
  acceptedContentOpportunities(accountId: string): Promise<readonly Opportunity[]>
}

/** Lane D produces the scheduler; Lane C's onboarding run seeds the calendar. */
export interface ScheduledTopic {
  readonly topicId: string
  readonly opportunityId: string
  /** ISO date, no time: the calendar is a grid of days, not a schedule of moments. */
  readonly scheduledFor: string
  readonly title: string
  readonly state: 'planned' | 'checking' | 'generating' | 'in_review' | 'published' | 'rejected_by_gate' | 'vetoed'
}

export interface TopicScheduler {
  /**
   * Picks the next open calendar day by default; a caller may name any future
   * day instead. A pinned occupant is never displaced.
   */
  schedule(opportunity: Opportunity, date?: string): Promise<ScheduledTopic>
}

/**
 * Lane D's judge, reused by Lane E to grade OPTIMIZE recommendations. It is a
 * separate call, blind to the writer's context, and never run on a cheaper
 * model — a grader that saw the writer's reasoning, or that thought less hard
 * than the writer did, is not a check on anything.
 */
export interface JudgeScores {
  readonly informationGain: number
  readonly factualGrounding: number
  readonly [criterion: string]: number
}

export interface JudgeVerdict {
  readonly passed: boolean
  readonly scores: JudgeScores
  /** Plain-language justification per criterion; the merchant reads these on the rejection card. */
  readonly justifications: Readonly<Record<string, string>>
  readonly promptVersion: string
  readonly modelId: string
}

export interface JudgeLite {
  grade(recommendation: unknown, pack: unknown): Promise<JudgeVerdict>
}

/**
 * Lane B's product/collection change stream, consumed by Lane C's content
 * inventory and Lane D's drift detection.
 */
export interface CatalogEvent {
  readonly accountId: string
  readonly kind:
    | 'product_created'
    | 'product_updated'
    | 'product_deleted'
    | 'collection_updated'
    | 'article_updated'
    | 'article_deleted'
    | 'page_updated'
    | 'page_deleted'
    | 'price_changed'
    | 'availability_changed'
  readonly entityId: string
  /** Deliveries arrive out of order as a matter of course; consumers order by this rather than by arrival. */
  readonly occurredAt: string
  readonly changedFields: readonly string[]
}

export interface CatalogEvents {
  since(accountId: string, cursor?: string): Promise<{ events: readonly CatalogEvent[]; cursor: string }>
}

/**
 * Notifications are append-only rows, unique on
 * `(account_id, type, dedupe_key)`, so a retried job cannot notify twice. Every
 * lane emits at its own points.
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
   * `refs` holds **references only** (topic_id, article_id, opportunity_id …).
   * Display text is produced at render time, so a copy fix never requires
   * rewriting stored rows.
   */
  emit(
    type: NotificationType,
    refs: Readonly<Record<string, string>>,
    dedupeKey: string,
    attribution: EventAttribution,
  ): Promise<{ created: boolean }>
}

import type { TemplatedLine } from '../opportunities/types'

/**
 * The response bodies the three Content screens read, written out here rather
 * than derived from the API's zod schemas.
 *
 * Same reasoning as the Opportunities screen next door: the schemas are the
 * contract, this is one consumer's view of it, and keeping them apart is what
 * lets a calendar be rendered in a test from four hand-made topics with no
 * validation library in the browser bundle. The screen contract beside this
 * folder is what stops the two drifting — every field named below is registered
 * there, and a test asserts each one still resolves in the mock fixtures the
 * schemas validate.
 */

export type IntentClass = 'buying_guide' | 'comparison' | 'how_to' | 'informational'

/**
 * Where a topic is in its life. `checking` is the one the merchant creates: a
 * hand-added topic goes through the same admission gate as one we picked, and
 * sits in this state while that runs.
 */
export type TopicState =
  | 'planned'
  | 'checking'
  | 'generating'
  | 'in_review'
  | 'published'
  | 'rejected_by_gate'
  | 'vetoed'

export type TopicSource = 'auto' | 'manual' | 'exploration'

export type GateName = 'gate_1' | 'gate_2' | 'gate_3'

export interface TopicRejection {
  readonly gate: GateName
  readonly reason: TemplatedLine
}

export interface CalendarTopic {
  readonly id: string
  readonly title: string
  /** The date it is scheduled to generate on. One topic per day, at most. */
  readonly scheduledFor: string
  readonly state: TopicState
  readonly intentClass: IntentClass
  readonly kind: 'new' | 'refresh'
  readonly source: TopicSource
  readonly pinned: boolean
  readonly targetKeyword: string | null
  readonly monthlySearchVolume: number | null
  readonly why: TemplatedLine
  /** The opportunity this topic came from, so the chip can link back to it. */
  readonly opportunityId: string | null
  readonly signalType: string | null
  readonly articleId: string | null
  readonly rejection: TopicRejection | null
}

export interface CalendarResponse {
  readonly topics: readonly CalendarTopic[]
  /** Vacation mode, a lost connection or a kill switch — the ribbon over future weeks. */
  readonly paused: { readonly active: boolean; readonly reason: string | null }
  readonly nextReplenishmentAt: string | null
}

export type AddTopicOutcome = 'planned' | 'planned_with_warning' | 'converted' | 'rejected'

export interface AddTopicResponse {
  readonly outcome: AddTopicOutcome
  readonly topic: CalendarTopic | null
  readonly warning: TemplatedLine | null
  /** Set when the admission gate found we already rank for this and made an OPTIMIZE instead. */
  readonly convertedToOpportunityId: string | null
  readonly rejection: TemplatedLine | null
}

// ── Articles ────────────────────────────────────────────────────────────────

export type ArticleState = 'draft' | 'in_review' | 'published' | 'rejected' | 'discarded'

export type DeliveryMode = 'export' | 'auto'

export type OutcomeLabel = 'winner' | 'neutral' | 'underperformer' | 'unrated'

export interface ArticlePerformance {
  readonly clicks28d: number
  readonly position: number
  readonly trend: 'up' | 'flat' | 'down'
  readonly label: OutcomeLabel
}

export interface ArticleSummary {
  readonly id: string
  readonly title: string
  readonly state: ArticleState
  readonly delivery: DeliveryMode
  readonly publishedAt: string | null
  readonly publishedUrl: string | null
  /** Published past a failed quality gate on the merchant's instruction. Shown, never hidden. */
  readonly publishedViaOverride: boolean
  readonly repaired: boolean
  readonly refreshedCount: number
  /** Null until 28 days have passed, because anything earlier is noise. */
  readonly performance: ArticlePerformance | null
}

export interface ArticlesResponse {
  readonly articles: readonly ArticleSummary[]
  readonly cursor: string | null
}

export interface ArticleMetadata {
  readonly targetKeyword: string
  readonly slug: string
  readonly metaDescription: string
  readonly familyIds: readonly string[]
  readonly opportunityId: string | null
}

export interface QualityReport {
  /** One score per criterion, on the judge's own scale. */
  readonly scores: Readonly<Record<string, number>>
  readonly justifications: Readonly<Record<string, string>>
  readonly promptVersion: string
  readonly modelId: string
  readonly passed: boolean
}

export interface ArticleDetailResponse {
  readonly article: ArticleSummary
  /** Rendered exactly as it will publish. There is no editor anywhere in the product. */
  readonly html: string
  readonly metadata: ArticleMetadata
  readonly evidencePack: readonly { readonly productId: string; readonly title: string }[]
  readonly qualityReport: QualityReport | null
  readonly history: readonly { readonly at: string; readonly event: string }[]
}

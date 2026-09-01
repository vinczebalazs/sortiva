import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { accounts } from './accounts'
import {
  impactBandEnum,
  opportunityEntityTypeEnum,
  opportunityStatusEnum,
  opportunityTaskKindEnum,
  opportunityTaskStateEnum,
  optimizeRecommendationStateEnum,
  recommendedActionEnum,
  signalRunKindEnum,
  signalTypeEnum,
} from './enums'

/** The statuses an opportunity is still open in. */
export const OPEN_OPPORTUNITY_STATUSES = [
  'new',
  'accepted',
  'scheduled',
  'executing',
  'blocked',
] as const

/**
 * One thing worth doing for one store, and the record of why we think so.
 *
 * A signal is never mapped straight onto an action: every row carries its own
 * evidence, impact, confidence, reason key, recommended action, preconditions
 * and the version of the rules that produced it. All of those are `NOT NULL`,
 * so a row that cannot explain itself cannot be written at all.
 *
 * `reason_template_key` + `reason_params_json` are the *only* way
 * a why-line is produced. There is deliberately no column holding rendered
 * prose, because a column that exists is a column an LLM's output can be put in.
 *
 * Invariant 10: re-detection updates the open row; it never duplicates, and
 * expiry never deletes.
 */
export const opportunities = pgTable(
  'opportunities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    signalType: signalTypeEnum('signal_type').notNull(),
    entityType: opportunityEntityTypeEnum('entity_type').notNull(),
    /** Part of the dedupe key, so it is an identity rather than a display field. */
    entityRef: text('entity_ref').notNull(),
    /** Auditable: each fact carries where it came from, over what window, and when we fetched it. */
    evidenceJson: jsonb('evidence_json').notNull(),
    impact: impactBandEnum('impact').notNull(),
    /** 0–100, a percentile rank within this store's own candidates of the same action type — never a cross-store number. */
    impactScore: integer('impact_score').notNull(),
    /** 0–100 stored; the merchant sees a band. */
    confidence: integer('confidence').notNull(),
    reasonTemplateKey: text('reason_template_key').notNull(),
    reasonParamsJson: jsonb('reason_params_json').notNull().default(sql`'{}'::jsonb`),
    recommendedAction: recommendedActionEnum('recommended_action').notNull(),
    /** Anything that must be resolved first. Non-empty means the row is blocked; e.g. `["catalog_richness_gap"]`. */
    preconditionsJson: jsonb('preconditions_json').notNull().default(sql`'[]'::jsonb`),
    status: opportunityStatusEnum('status').notNull().default('new'),
    /**
     * Produced without Search Console data, so it rests on inference rather
     * than measurement. The analytics event carries it and the card renders the
     * Limited Intelligence badge from it, which is why it is stored rather than
     * recomputed.
     */
    limitedIntelligence: boolean('limited_intelligence').notNull().default(false),
    /**
     * `topics` and `articles` arrive in schema wave 3 (T4.0), which adds the
     * foreign keys. Until then these are unconstrained ids.
     */
    topicId: uuid('topic_id'),
    articleId: uuid('article_id'),
    /** Invariant 9 — the hash of `signals.config.yaml` that produced this row. */
    rulesVersion: text('rules_version').notNull(),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Why the row expired. Expiry records a reason and never deletes: the history is what the learning loop reads. */
    expiredReason: text('expired_reason'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    /** Null until the 28-day measurement runs; before that there is nothing honest to record. */
    outcomeJson: jsonb('outcome_json'),
    outcomeMeasuredAt: timestamp('outcome_measured_at', { withTimezone: true }),
  },
  (t) => [
    /**
     * Only one *open* opportunity may exist per
     * `(account_id, signal_type, entity_ref)`, so a signal detected again next
     * week updates the evidence and score on the existing row instead of
     * stacking up duplicates in the merchant's list. Completed, dismissed and
     * expired rows stay as history and feed learning, which is why they are
     * outside the index.
     */
    uniqueIndex('opportunities_open_signal_entity_key')
      .on(t.accountId, t.signalType, t.entityRef)
      .where(sql`${t.status} IN ('new', 'accepted', 'scheduled', 'executing', 'blocked')`),
    index('opportunities_account_status_idx').on(t.accountId, t.status),
    index('opportunities_account_rank_idx').on(t.accountId, t.impactScore, t.confidence),
    index('opportunities_rules_version_idx').on(t.rulesVersion),
  ],
)

/**
 * The concrete units of work an opportunity decomposes into — the things the
 * merchant marks applied one at a time on the recommendation card.
 */
export const opportunityTasks = pgTable(
  'opportunity_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    kind: opportunityTaskKindEnum('kind').notNull(),
    description: text('description').notNull(),
    suggestedCopyRef: text('suggested_copy_ref'),
    evidenceRefs: text('evidence_refs').array().notNull().default(sql`'{}'::text[]`),
    state: opportunityTaskStateEnum('state').notNull().default('open'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
  },
  (t) => [index('opportunity_tasks_opportunity_idx').on(t.opportunityId, t.state)],
)

/**
 * The generated advice for one existing store page. Nothing here is ever
 * written to Shopify in V1 — the merchant copies or downloads it. A
 * recommendation that fails its grounding check twice is stored as
 * `failed_validation` rather than shown half-finished.
 */
export const optimizeRecommendations = pgTable(
  'optimize_recommendations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    pageUrl: text('page_url').notNull(),
    recommendationJson: jsonb('recommendation_json').notNull(),
    /** The grader's scores for this recommendation: grounding and intent match, each of which has to clear its floor. */
    judgeScoresJson: jsonb('judge_scores_json'),
    /** Invariant 25 — prompt version and model id stamped on every artefact. */
    promptVersion: text('prompt_version').notNull(),
    modelId: text('model_id').notNull(),
    rulesVersion: text('rules_version').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
    state: optimizeRecommendationStateEnum('state').notNull().default('valid'),
  },
  (t) => [index('optimize_recommendations_opportunity_idx').on(t.opportunityId, t.state)],
)

/**
 * One row per detection pass, with the counts the run's analytics event
 * reports. `(account_id, run_id)` is unique, so a queue that delivers the same
 * pass twice still records it once.
 */
export const signalRuns = pgTable(
  'signal_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    kind: signalRunKindEnum('kind').notNull(),
    rulesVersion: text('rules_version').notNull(),
    signalsEvaluated: integer('signals_evaluated').notNull().default(0),
    opportunitiesCreated: integer('opportunities_created').notNull().default(0),
    opportunitiesUpdated: integer('opportunities_updated').notNull().default(0),
    opportunitiesExpired: integer('opportunities_expired').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('signal_runs_account_run_key').on(t.accountId, t.runId)],
)

/**
 * The opportunity-level not-interested list. Keyed on the same
 * `(signal_type, entity_ref)` pair the dedupe index uses, so a dismissed
 * signal is never re-proposed — with a "show dismissed" view to undo it.
 */
export const dismissedOpportunities = pgTable(
  'dismissed_opportunities',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    signalType: signalTypeEnum('signal_type').notNull(),
    entityRef: text('entity_ref').notNull(),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('dismissed_opportunities_key').on(t.accountId, t.signalType, t.entityRef),
  ],
)

/**
 * The layered configuration table. V1 ships global and per-locale defaults from
 * `packages/rules/signals.config.yaml` and this table stays empty; it exists now
 * so the layering code path is real and exercised rather than retrofitted under
 * a live system later. Either way no threshold literal lives in application
 * code.
 *
 * `account_id` is null for a global or locale-wide override, so this is one of
 * the tables reached under `SystemScope`; see `scope.ts`.
 */
export const rulesOverrides = pgTable(
  'rules_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    locale: text('locale'),
    pageType: text('page_type'),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    updatedBy: text('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('rules_overrides_key_idx').on(t.key)],
)

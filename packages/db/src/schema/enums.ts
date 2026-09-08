import { pgEnum } from 'drizzle-orm/pg-core'

/**
 * Closed enums are Postgres enums, not text-with-a-check: adding a value costs
 * a migration. That friction is the point — a new type of anything here also
 * needs a template and a matrix row, so it must never be addable at runtime.
 */

/** One tier. There is no plan ladder to reason about anywhere in the product. */
export const planEnum = pgEnum('plan', ['pro'])

/**
 * The local mirror of Stripe's subscription status; `active` is the only one
 * that entitles anything.
 *
 * `incomplete` is a fifth value beyond the four the specs enumerate. It exists
 * because Stripe distinguishes a merchant whose
 * first payment is still being authorised (`incomplete`) from one whose
 * authorisation window ran out (`incomplete_expired`); folding the first into
 * the second records someone mid-purchase as someone who gave up, and then
 * counts them as churn on the signup funnel. Neither status is entitled, so no
 * gating behaviour changes. Founder-directed under card T1.2a; both spec
 * enumerations need the matching edit. See DECISIONS 2026-09-01 T1.2a.
 */
export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active',
  'past_due',
  'canceled',
  'incomplete',
  'incomplete_expired',
])

/** Where a domain sits in onboarding, from first claim to fully ingested. */
export const domainPlatformEnum = pgEnum('domain_platform', ['shopify', 'custom_unsupported'])
export const domainStateEnum = pgEnum('domain_state', [
  'ingesting',
  'awaiting_shopify_auth',
  'needs_confirmation',
  'ready_for_planning',
  'unsupported',
])

/** The ingestion pipeline's steps, `gsc_connect` included. */
export const jobStepEnum = pgEnum('job_step', [
  'detect',
  'oauth_wait',
  'catalog_sync',
  'distill',
  'family_group',
  'persona',
  'keywords_competitors',
  'gsc_connect',
  'awaiting_confirmation',
])

/** One step's lifecycle: `pending → running → succeeded | failed_retryable | failed_terminal | skipped`. */
export const jobStepStateEnum = pgEnum('job_step_state', [
  'pending',
  'running',
  'succeeded',
  'failed_retryable',
  'failed_terminal',
  'skipped',
])

export const ingestionJobStatusEnum = pgEnum('ingestion_job_status', [
  'running',
  'succeeded',
  'failed',
  'abandoned',
])

/** The kill switches, by what each one stops. */
export const opsFlagScopeEnum = pgEnum('ops_flag_scope', ['global', 'account'])
export const opsFlagTrippedByEnum = pgEnum('ops_flag_tripped_by', ['manual', 'auto'])

/** Export is the default; publishing on the merchant's behalf needs a separate, later consent. */
export const deliveryModeEnum = pgEnum('delivery_mode', ['export', 'auto'])

/** Whether new articles land as drafts or live, set per account. */
export const shopifyPublishAsEnum = pgEnum('shopify_publish_as', ['live', 'draft'])

/**
 * One value per row of the notification matrix; each has a template and a
 * place in the UI.
 *
 * `account_deletion_confirmed` was added by schema wave 3 (T4.0) — see
 * DECISIONS 2026-09-03 T4.0. It is account-security mail (tech §1.5 exempts
 * it from suppression; `EmailAudience.securityEmail` already carries the
 * bypass) and its send record lives in `deletion_confirmation_emails`, not
 * `email_sends`, because `email_sends` cascades from `accounts` and the
 * record of "we told them" must outlive the account it confirms.
 */
export const notificationTypeEnum = pgEnum('notification_type', [
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
  'account_deletion_confirmed',
])

/** Where one email got to: queued, sent, or stopped. */
export const emailSendStateEnum = pgEnum('email_send_state', [
  'queued',
  'sent',
  'failed',
  'suppressed',
])

/** Why we stopped emailing an address. These arrive from the mail provider's bounce and complaint webhooks. */
export const emailSuppressionReasonEnum = pgEnum('email_suppression_reason', [
  'bounced',
  'complained',
  'unsubscribed',
])

/** How often a merchant wants digests, if at all. Off unless they ask. */
export const emailDigestFrequencyEnum = pgEnum('email_digest_frequency', [
  'off',
  'daily',
  'weekly',
])

/** Which provider a `webhook_events` row came from. */
export const webhookSourceEnum = pgEnum('webhook_source', ['shopify', 'resend'])

/** Where a received webhook got to. We insert-or-ignore first and process from the table, so a redelivery is free. */
export const webhookStatusEnum = pgEnum('webhook_status', [
  'received',
  'processing',
  'processed',
  'failed',
  'ignored',
])

// ───────────────────────── schema wave 2 (T2.0) ─────────────────────────────

/**
 * The values are the keys of `defaults.signals` in
 * `packages/rules/signals.config.yaml`, copied
 * verbatim: detection reads a threshold by signal key, so a row whose
 * `signal_type` does not name a config key has no thresholds to be judged by.
 */
export const signalTypeEnum = pgEnum('signal_type', [
  'striking_distance',
  'low_ctr_at_strong_rank',
  'content_decay',
  'cannibalization',
  'uncovered_commercial_query',
  'existing_page_intent_gap',
  'competitor_coverage_gap',
  'product_family_coverage_gap',
  'catalog_richness_gap',
  'missing_or_weak_metadata',
  'product_change_impact',
  'broken_product_reference',
  'internal_linking_gap',
  'orphan_page',
  'indexing_issue',
  'wrong_canonical_or_duplicate',
  'content_overlap',
  'freshness_opportunity',
])

/** What an opportunity's `entity_ref` points at. */
export const opportunityEntityTypeEnum = pgEnum('opportunity_entity_type', [
  'query_cluster',
  'url',
  'family',
  'article',
  'product',
])

/** What we propose doing: create, optimize, refresh, fix, or hold. */
export const recommendedActionEnum = pgEnum('recommended_action', [
  'create',
  'optimize',
  'refresh',
  'fix',
  'hold',
])

/** An opportunity's lifecycle: `new → accepted → scheduled → executing → completed | dismissed | blocked | expired`. */
export const opportunityStatusEnum = pgEnum('opportunity_status', [
  'new',
  'accepted',
  'scheduled',
  'executing',
  'completed',
  'dismissed',
  'blocked',
  'expired',
])

/** The band the merchant sees. The 0–100 score behind it is what is stored and compared. */
export const impactBandEnum = pgEnum('impact_band', ['low', 'medium', 'high'])

/** How sure we are of a grouping. Families produced by the embeddings fallback rather than a clean attribute match are always `low`. */
export const confidenceBandEnum = pgEnum('confidence_band', ['low', 'medium', 'high'])

/** Where a merchant-facing task stands: still open, done, or deliberately skipped. */
export const opportunityTaskKindEnum = pgEnum('opportunity_task_kind', [
  'title_rewrite',
  'meta_rewrite',
  'add_section',
  'add_faq',
  'internal_links',
  'product_data',
  'consolidate',
  'primary_url',
  'canonical_recommendation',
  'schedule_topic',
  'repair_reference',
])

export const opportunityTaskStateEnum = pgEnum('opportunity_task_state', [
  'open',
  'applied',
  'skipped',
])

/** A recommendation that fails its grounding check twice ends as `failed_validation`. We never hand over half of one. */
export const optimizeRecommendationStateEnum = pgEnum('optimize_recommendation_state', [
  'valid',
  'failed_validation',
  'superseded',
])

/** The three cadences a detection run happens on. */
export const signalRunKindEnum = pgEnum('signal_run_kind', ['onboarding', 'weekly', 'event'])

/** What kind of page this is on the merchant's store. `article_ours` is how we tell content we wrote from content they wrote. */
export const storePageTypeEnum = pgEnum('store_page_type', [
  'collection',
  'product',
  'page',
  'blog_article',
  'article_ours',
  'other',
])

/**
 * Which condition a `store_pages` row is in. `gone` records that the store no
 * longer has this URL, without deleting the row — the row is the only record
 * that the address ever existed. Two values today; the shape leaves room for
 * `moved` or `unreachable` later (T4.0a — nothing writes or reads this value
 * yet, it is a mini schema wave ahead of the code that will).
 */
export const storePageStatusEnum = pgEnum('store_page_status', ['live', 'gone'])

/** What the searcher is trying to do, which is what picks the page type we write. */
export const intentClassEnum = pgEnum('intent_class', [
  'buying_guide',
  'comparison',
  'how_to',
  'informational',
])

/** Which signal produced a family. Recorded on every one, so a bad grouping can be traced to the thing that made it. */
export const familyGroupingSourceEnum = pgEnum('family_grouping_source', [
  'collection',
  'split_variant',
  'fact_cluster',
  'embedding',
])

/** Whether we found this during ingestion or the merchant added it themselves. */
export const discoverySourceEnum = pgEnum('discovery_source', ['auto', 'manual'])

/** Whether this came out of the 90-day order aggregation or the merchant named it. */
export const topProductSourceEnum = pgEnum('top_product_source', ['orders_api', 'manual'])

/**
 * The paid vendors behind the three instrumented wrappers — `packages/llm`,
 * `SeoDataProvider`, `EmailProvider` — which are the only code allowed to reach
 * them. The daily spend caps are computed over `anthropic` and `dataforseo`;
 * `resend` is here because the
 * ledger is append-only and a wrapper that already exists must not need a
 * migration it is not allowed to add. See DECISIONS 2026-08-31 T2.0.
 */
export const spendVendorEnum = pgEnum('spend_vendor', ['anthropic', 'dataforseo', 'resend'])

/**
 * Recording a cost is an obligation of *making* the call, not of the call
 * succeeding: both vendors bill for work performed. `docs/audits/remediation.md`
 * D2 makes every failure path emit a record; this column is what tells the two
 * apart afterwards.
 */
export const spendOutcomeEnum = pgEnum('spend_outcome', ['succeeded', 'failed'])

// ───────────────────────── schema wave 3 (T4.0) ─────────────────────────────

/** Whether a topic is new coverage or an existing article coming back for another pass. */
export const topicKindEnum = pgEnum('topic_kind', ['new', 'refresh'])

/** Who put the topic on the calendar. `exploration` is the replenishment planner's own deliberate long-shot slice, §9.6.6. */
export const topicSourceEnum = pgEnum('topic_source', ['auto', 'manual', 'exploration'])

/** The calendar's state machine, main §8.7: `planned → generating → in_review (if draft review is on) → published | rejected_by_gate | vetoed`. */
export const topicStateEnum = pgEnum('topic_state', [
  'planned',
  'generating',
  'in_review',
  'published',
  'rejected_by_gate',
  'vetoed',
])

/**
 * An article's own lifecycle, main §13 `articles`.
 *
 * `cleared_to_deliver` is the schema mini-wave `T-WAVE5` addition, and means
 * exactly what it says: a merchant has overruled the quality rejection and the
 * article is to go out. It exists because `draft` meant three different things
 * at once — written but not yet graded, graded and sent back, and overruled —
 * so anything asking "which articles go out today" had to join the
 * gate-decision table to tell them apart, or quietly include un-graded work.
 * The `published_via_override` flag does not answer that question: its meaning
 * is "keep this out of the learning data", not "cleared to publish".
 *
 * Appended rather than slotted after `in_review`, so no existing row's stored
 * value or sort position moves. Nothing writes it yet — see `DECISIONS.md`,
 * 2026-09-04.
 */
export const articleStateEnum = pgEnum('article_state', [
  'draft',
  'in_review',
  'published',
  'rejected',
  'discarded',
  'cleared_to_deliver',
])

/** The four kinds of assertion a claim plan may contain — main content-pointers.md §1. Collapsing these is how a generated article ends up stating an opinion as a specification. */
export const claimKindEnum = pgEnum('claim_kind', [
  'merchant_fact',
  'external_fact',
  'derived_fact',
  'recommendation',
])

/** What kind of mention a product reference is — main §13 `article_product_refs`. */
export const productRefTypeEnum = pgEnum('product_ref_type', ['link', 'recommendation', 'mention'])

/**
 * The volatile fields a placeholder in an article body may stand in for.
 * Never a literal in the body itself — main §13, and the founder decision of
 * 2026-09-01 (`DECISIONS.md`, card T4.0) that retired storing a price as text.
 */
export const productRefFieldEnum = pgEnum('product_ref_field', [
  'price',
  'stock',
  'sale_status',
  'url',
  'title',
])

/** One row per gate/topic evaluation, main §13 `gate_decisions`. The gate number itself is a plain smallint (checked 1–3), not an enum — see that table's comment. */

/** Two-phase publish, main §14.3.7. */
export const publishIntentStateEnum = pgEnum('publish_intent_state', [
  'pending',
  'confirmed',
  'abandoned',
])

/** How a weekly-recomputed article performed against the store's own median — main §13 `article_labels`, §9.6.2. */
export const articleLabelEnum = pgEnum('article_label', [
  'winner',
  'neutral',
  'underperformer',
  'unrated',
])

/** What a pattern multiplier is computed over — main §13 `pattern_stats`, §9.6.3. Unused until T7.1 (deferred, `DECISIONS.md` 2026-09-02); the table ships now because T4.6 reads it with a stub multiplier. */
export const patternDimensionEnum = pgEnum('pattern_dimension', [
  'intent_class',
  'family',
  'keyword_cluster',
  'action_type',
])

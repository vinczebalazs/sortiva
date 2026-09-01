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

/** One value per row of the notification matrix; each has a template and a place in the UI. */
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

import { pgEnum } from 'drizzle-orm/pg-core'

/**
 * Closed enums are Postgres enums, not text-with-a-check: adding a value is a
 * migration, which is exactly the friction tech §1.2 asks for ("Adding a type
 * is a code change (enum + template + matrix row), never dynamic").
 */

/** main §4.2 — single tier. */
export const planEnum = pgEnum('plan', ['pro'])

/**
 * main §4.2, §13 `subscriptions`. Entitled = `active`.
 *
 * `incomplete` is a fifth value the spec text does not list — main §4.2 and §13
 * both enumerate four. It exists because Stripe distinguishes a merchant whose
 * first payment is still being authorised (`incomplete`) from one whose
 * authorisation window ran out (`incomplete_expired`); folding the first into
 * the second records someone mid-purchase as someone who gave up, and then
 * counts them as churn on the §14.7 funnel. Neither status is entitled, so no
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

/** main §13 `domains`. */
export const domainPlatformEnum = pgEnum('domain_platform', ['shopify', 'custom_unsupported'])
export const domainStateEnum = pgEnum('domain_state', [
  'ingesting',
  'awaiting_shopify_auth',
  'needs_confirmation',
  'ready_for_planning',
  'unsupported',
])

/** main §14.3.1 — the ingestion pipeline's steps, `gsc_connect` included. */
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

/** main §14.3.1 — `pending → running → succeeded | failed_retryable | failed_terminal | skipped`. */
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

/** main §14.5 — kill switches. */
export const opsFlagScopeEnum = pgEnum('ops_flag_scope', ['global', 'account'])
export const opsFlagTrippedByEnum = pgEnum('ops_flag_tripped_by', ['manual', 'auto'])

/** main §9.5 — export is the default; auto-publish is the opt-in second consent. */
export const deliveryModeEnum = pgEnum('delivery_mode', ['export', 'auto'])

/** main §9.4 — per-account draft-vs-live default, live by default. */
export const shopifyPublishAsEnum = pgEnum('shopify_publish_as', ['live', 'draft'])

/** tech §1.2 — closed enum matching the UI spec §10 matrix rows. */
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

/** tech §1.4 — `email_sends.state`. */
export const emailSendStateEnum = pgEnum('email_send_state', [
  'queued',
  'sent',
  'failed',
  'suppressed',
])

/** tech §1.5 — suppression reasons come from Resend's bounce/complaint webhooks. */
export const emailSuppressionReasonEnum = pgEnum('email_suppression_reason', [
  'bounced',
  'complained',
  'unsubscribed',
])

/** tech §1.3 — `off | daily | weekly`, default off. */
export const emailDigestFrequencyEnum = pgEnum('email_digest_frequency', [
  'off',
  'daily',
  'weekly',
])

/** main §14.3.8 / tech §3 — which provider a `webhook_events` row came from. */
export const webhookSourceEnum = pgEnum('webhook_source', ['shopify', 'resend'])

/** main §14.3.8 — insert-or-ignore, then process from the table. */
export const webhookStatusEnum = pgEnum('webhook_status', [
  'received',
  'processing',
  'processed',
  'failed',
  'ignored',
])

// ───────────────────────── schema wave 2 (T2.0) ─────────────────────────────

/**
 * main §7.3 — "Required; closed enum matching §7.3" (§7.6). The values are the
 * keys of `defaults.signals` in `packages/rules/signals.config.yaml`, copied
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

/** main §13 `opportunities` — what `entity_ref` points at. */
export const opportunityEntityTypeEnum = pgEnum('opportunity_entity_type', [
  'query_cluster',
  'url',
  'family',
  'article',
  'product',
])

/** main §7.4 — CREATE / OPTIMIZE / REFRESH / FIX / HOLD, spelled as §13 spells them. */
export const recommendedActionEnum = pgEnum('recommended_action', [
  'create',
  'optimize',
  'refresh',
  'fix',
  'hold',
])

/** main §7.9 — `new → accepted → scheduled → executing → completed | dismissed | blocked | expired`. */
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

/** main §7.6 — `impact_score` (0–100) is stored; the band is what the merchant sees. */
export const impactBandEnum = pgEnum('impact_band', ['low', 'medium', 'high'])

/** main §6.4 — the embeddings fallback is "flagged `confidence = low`". */
export const confidenceBandEnum = pgEnum('confidence_band', ['low', 'medium', 'high'])

/** main §13 `opportunity_tasks`, §7.5 step 6, §10.4. */
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

/** main §10.3 step 4 — a recommendation failing grounding twice is `failed_validation`, never a half-recommendation. */
export const optimizeRecommendationStateEnum = pgEnum('optimize_recommendation_state', [
  'valid',
  'failed_validation',
  'superseded',
])

/** main §7.5 — the three cadences a detection run happens on. */
export const signalRunKindEnum = pgEnum('signal_run_kind', ['onboarding', 'weekly', 'event'])

/** main §12.3 / §13 `store_pages`. `article_ours` is how §10.5 tells our content from the merchant's. */
export const storePageTypeEnum = pgEnum('store_page_type', [
  'collection',
  'product',
  'page',
  'blog_article',
  'article_ours',
  'other',
])

/** main §8.7 — the intent class picks the content/page type. */
export const intentClassEnum = pgEnum('intent_class', [
  'buying_guide',
  'comparison',
  'how_to',
  'informational',
])

/** main §6.4 — "Every family records which signal produced it … so misgroupings are debuggable". */
export const familyGroupingSourceEnum = pgEnum('family_grouping_source', [
  'collection',
  'split_variant',
  'fact_cluster',
  'embedding',
])

/** main §13 `keywords` / `competitors` — auto-detected during ingestion, or added by hand at §6.8. */
export const discoverySourceEnum = pgEnum('discovery_source', ['auto', 'manual'])

/** main §13 `top_products` — the 90-day order aggregation, or a merchant override. */
export const topProductSourceEnum = pgEnum('top_product_source', ['orders_api', 'manual'])

/**
 * The paid vendors behind the three instrumented wrappers of invariant 25
 * (`packages/llm`, `SeoDataProvider`, `EmailProvider`). main §14.5's caps are
 * computed over `anthropic` and `dataforseo`; `resend` is here because the
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

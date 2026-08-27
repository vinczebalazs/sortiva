import { pgEnum } from 'drizzle-orm/pg-core'

/**
 * Closed enums are Postgres enums, not text-with-a-check: adding a value is a
 * migration, which is exactly the friction tech §1.2 asks for ("Adding a type
 * is a code change (enum + template + matrix row), never dynamic").
 */

/** main §4.2 — single tier. */
export const planEnum = pgEnum('plan', ['pro'])

/** main §4.2, §13 `subscriptions`. Entitled = `active`. */
export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active',
  'past_due',
  'canceled',
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

CREATE TYPE "public"."delivery_mode" AS ENUM('export', 'auto');--> statement-breakpoint
CREATE TYPE "public"."domain_platform" AS ENUM('shopify', 'custom_unsupported');--> statement-breakpoint
CREATE TYPE "public"."domain_state" AS ENUM('ingesting', 'awaiting_shopify_auth', 'needs_confirmation', 'ready_for_planning', 'unsupported');--> statement-breakpoint
CREATE TYPE "public"."email_digest_frequency" AS ENUM('off', 'daily', 'weekly');--> statement-breakpoint
CREATE TYPE "public"."email_send_state" AS ENUM('queued', 'sent', 'failed', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."email_suppression_reason" AS ENUM('bounced', 'complained', 'unsubscribed');--> statement-breakpoint
CREATE TYPE "public"."ingestion_job_status" AS ENUM('running', 'succeeded', 'failed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."job_step" AS ENUM('detect', 'oauth_wait', 'catalog_sync', 'distill', 'family_group', 'persona', 'keywords_competitors', 'gsc_connect', 'awaiting_confirmation');--> statement-breakpoint
CREATE TYPE "public"."job_step_state" AS ENUM('pending', 'running', 'succeeded', 'failed_retryable', 'failed_terminal', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('ingestion_review_ready', 'opportunities_ready', 'new_opportunities_found', 'optimize_recommendation_ready', 'merchant_task_created', 'article_published', 'draft_ready_for_review', 'topic_held_by_gate', 'repair_needed', 'connection_lost_shopify', 'connection_lost_gsc', 'payment_failed', 'monthly_summary_ready', 'export_url_reminder', 'oauth_reminder');--> statement-breakpoint
CREATE TYPE "public"."ops_flag_scope" AS ENUM('global', 'account');--> statement-breakpoint
CREATE TYPE "public"."ops_flag_tripped_by" AS ENUM('manual', 'auto');--> statement-breakpoint
CREATE TYPE "public"."plan" AS ENUM('pro');--> statement-breakpoint
CREATE TYPE "public"."shopify_publish_as" AS ENUM('live', 'draft');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('active', 'past_due', 'canceled', 'incomplete_expired');--> statement-breakpoint
CREATE TYPE "public"."webhook_source" AS ENUM('shopify', 'resend');--> statement-breakpoint
CREATE TYPE "public"."webhook_status" AS ENUM('received', 'processing', 'processed', 'failed', 'ignored');--> statement-breakpoint
CREATE TABLE "account_settings" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"publish_hour" integer DEFAULT 9 NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"draft_review" boolean DEFAULT false NOT NULL,
	"auto_repair" boolean DEFAULT true NOT NULL,
	"delivery" "delivery_mode" DEFAULT 'export' NOT NULL,
	"shopify_publish_as" "shopify_publish_as" DEFAULT 'live' NOT NULL,
	"vacation_mode" boolean DEFAULT false NOT NULL,
	"ui_language" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"plan" "plan" DEFAULT 'pro' NOT NULL,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"price_id" text NOT NULL,
	"status" "subscription_status" NOT NULL,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"domain_normalized" text NOT NULL,
	"platform" "domain_platform",
	"state" "domain_state" DEFAULT 'ingesting' NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"release_after" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "preview_cache" (
	"domain_normalized" text PRIMARY KEY NOT NULL,
	"summary" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopify_conns" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"shop_handle" text NOT NULL,
	"access_token" text NOT NULL,
	"granted_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"target_blog_id" text,
	"target_blog_handle" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ingestion_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"status" "ingestion_job_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"step" "job_step" NOT NULL,
	"state" "job_step_state" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"output_ref" jsonb,
	"checkpoint" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "ops_flag_scope" NOT NULL,
	"account_id" uuid,
	"flag" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"tripped_by" "ops_flag_tripped_by" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reset_at" timestamp with time zone,
	"reset_by" text,
	CONSTRAINT "ops_flags_scope_account_ck" CHECK (("ops_flags"."scope" = 'global' AND "ops_flags"."account_id" IS NULL) OR ("ops_flags"."scope" = 'account' AND "ops_flags"."account_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "request_cache" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"response_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"webhook_id" text PRIMARY KEY NOT NULL,
	"source" "webhook_source" NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"status" "webhook_status" DEFAULT 'received' NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "email_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"dedupe_key" text NOT NULL,
	"template_version" text NOT NULL,
	"state" "email_send_state" DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "email_suppressions" (
	"email" text PRIMARY KEY NOT NULL,
	"reason" "email_suppression_reason" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_prefs" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"email_article_published" boolean DEFAULT false NOT NULL,
	"email_digest_frequency" "email_digest_frequency" DEFAULT 'off' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_conns" ADD CONSTRAINT "shopify_conns_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_steps" ADD CONSTRAINT "job_steps_job_id_ingestion_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ingestion_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_flags" ADD CONSTRAINT "ops_flags_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_email_key" ON "accounts" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_stripe_customer_id_key" ON "accounts" USING btree ("stripe_customer_id") WHERE "accounts"."stripe_customer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "stripe_events_unprocessed_idx" ON "stripe_events" USING btree ("received_at") WHERE "stripe_events"."processed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_key" ON "subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "subscriptions_synced_at_idx" ON "subscriptions" USING btree ("synced_at");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_account_id_key" ON "domains" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_domain_normalized_key" ON "domains" USING btree ("domain_normalized");--> statement-breakpoint
CREATE INDEX "domains_state_idx" ON "domains" USING btree ("state");--> statement-breakpoint
CREATE INDEX "preview_cache_expires_at_idx" ON "preview_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_conns_shop_handle_key" ON "shopify_conns" USING btree ("shop_handle");--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_jobs_account_run_key" ON "ingestion_jobs" USING btree ("account_id","run_id");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_account_status_idx" ON "ingestion_jobs" USING btree ("account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "job_steps_job_step_key" ON "job_steps" USING btree ("job_id","step");--> statement-breakpoint
CREATE INDEX "job_steps_idempotency_key_idx" ON "job_steps" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "job_steps_dispatch_idx" ON "job_steps" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ops_flags_active_global_key" ON "ops_flags" USING btree ("flag") WHERE "ops_flags"."reset_at" IS NULL AND "ops_flags"."scope" = 'global';--> statement-breakpoint
CREATE UNIQUE INDEX "ops_flags_active_account_key" ON "ops_flags" USING btree ("account_id","flag") WHERE "ops_flags"."reset_at" IS NULL AND "ops_flags"."scope" = 'account';--> statement-breakpoint
CREATE INDEX "ops_flags_active_idx" ON "ops_flags" USING btree ("scope","flag") WHERE "ops_flags"."reset_at" IS NULL;--> statement-breakpoint
CREATE INDEX "request_cache_expires_at_idx" ON "request_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed_idx" ON "webhook_events" USING btree ("received_at") WHERE "webhook_events"."processed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "webhook_events_received_at_idx" ON "webhook_events" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_sends_account_type_dedupe_key" ON "email_sends" USING btree ("account_id","type","dedupe_key");--> statement-breakpoint
CREATE INDEX "email_sends_queued_idx" ON "email_sends" USING btree ("queued_at") WHERE "email_sends"."state" = 'queued';--> statement-breakpoint
CREATE INDEX "email_sends_queued_at_idx" ON "email_sends" USING btree ("queued_at");--> statement-breakpoint
CREATE INDEX "email_suppressions_created_at_idx" ON "email_suppressions" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_account_type_dedupe_key" ON "notifications" USING btree ("account_id","type","dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_account_created_at_idx" ON "notifications" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_account_unseen_idx" ON "notifications" USING btree ("account_id") WHERE "notifications"."seen_at" IS NULL;--> statement-breakpoint
CREATE INDEX "notifications_created_at_idx" ON "notifications" USING btree ("created_at");
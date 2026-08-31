CREATE TYPE "public"."confidence_band" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."discovery_source" AS ENUM('auto', 'manual');--> statement-breakpoint
CREATE TYPE "public"."family_grouping_source" AS ENUM('collection', 'split_variant', 'fact_cluster', 'embedding');--> statement-breakpoint
CREATE TYPE "public"."impact_band" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."intent_class" AS ENUM('buying_guide', 'comparison', 'how_to', 'informational');--> statement-breakpoint
CREATE TYPE "public"."opportunity_entity_type" AS ENUM('query_cluster', 'url', 'family', 'article', 'product');--> statement-breakpoint
CREATE TYPE "public"."opportunity_status" AS ENUM('new', 'accepted', 'scheduled', 'executing', 'completed', 'dismissed', 'blocked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."opportunity_task_kind" AS ENUM('title_rewrite', 'meta_rewrite', 'add_section', 'add_faq', 'internal_links', 'product_data', 'consolidate', 'primary_url', 'canonical_recommendation', 'schedule_topic', 'repair_reference');--> statement-breakpoint
CREATE TYPE "public"."opportunity_task_state" AS ENUM('open', 'applied', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."optimize_recommendation_state" AS ENUM('valid', 'failed_validation', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."recommended_action" AS ENUM('create', 'optimize', 'refresh', 'fix', 'hold');--> statement-breakpoint
CREATE TYPE "public"."signal_run_kind" AS ENUM('onboarding', 'weekly', 'event');--> statement-breakpoint
CREATE TYPE "public"."signal_type" AS ENUM('striking_distance', 'low_ctr_at_strong_rank', 'content_decay', 'cannibalization', 'uncovered_commercial_query', 'existing_page_intent_gap', 'competitor_coverage_gap', 'product_family_coverage_gap', 'catalog_richness_gap', 'missing_or_weak_metadata', 'product_change_impact', 'broken_product_reference', 'internal_linking_gap', 'orphan_page', 'indexing_issue', 'wrong_canonical_or_duplicate', 'content_overlap', 'freshness_opportunity');--> statement-breakpoint
CREATE TYPE "public"."spend_outcome" AS ENUM('succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."spend_vendor" AS ENUM('anthropic', 'dataforseo', 'resend');--> statement-breakpoint
CREATE TYPE "public"."store_page_type" AS ENUM('collection', 'product', 'page', 'blog_article', 'article_ours', 'other');--> statement-breakpoint
CREATE TYPE "public"."top_product_source" AS ENUM('orders_api', 'manual');--> statement-breakpoint
CREATE TABLE "personas" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"product_categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"language" text NOT NULL,
	"country" text NOT NULL,
	"audience" text,
	"tone" text,
	"richness_score" numeric(6, 2),
	"prompt_version" text NOT NULL,
	"model_id" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_facts" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"facts_json" jsonb NOT NULL,
	"fact_count" integer DEFAULT 0 NOT NULL,
	"fluff_discarded" integer DEFAULT 0 NOT NULL,
	"prompt_version" text NOT NULL,
	"model_id" text NOT NULL,
	"distilled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_families" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"merged_facts_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"differentiation_axes" text[] DEFAULT '{}'::text[] NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"grouping_source" "family_grouping_source" NOT NULL,
	"confidence" "confidence_band" NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"shopify_product_id" text NOT NULL,
	"title" text NOT NULL,
	"raw_body_html" "bytea",
	"product_type" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"price_range" jsonb,
	"updated_at" timestamp with time zone,
	"checksum" text,
	"family_id" uuid,
	"logical_product_id" uuid,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "top_products" (
	"account_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"revenue_90d" numeric(14, 2),
	"qty_90d" integer,
	"source" "top_product_source" NOT NULL,
	"rank" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"domain_normalized" text NOT NULL,
	"source" "discovery_source" NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keywords" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"term" text NOT NULL,
	"language" text NOT NULL,
	"country" text NOT NULL,
	"volume" integer,
	"difficulty" integer,
	"cpc" numeric(10, 4),
	"source" "discovery_source" NOT NULL,
	"enriched_at" timestamp with time zone,
	"confirmed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"url" text NOT NULL,
	"page_type" "store_page_type" NOT NULL,
	"handle" text,
	"shopify_id" text,
	"title" text,
	"seo_title" text,
	"seo_description" text,
	"headings_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"body_compressed" "bytea",
	"outbound_internal_links" text[] DEFAULT '{}'::text[] NOT NULL,
	"family_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"intent_class" "intent_class",
	"checksum" text,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"article_id" uuid
);
--> statement-breakpoint
CREATE TABLE "ctr_curve" (
	"account_id" uuid NOT NULL,
	"fitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"curve_json" jsonb NOT NULL,
	"sample_n" integer DEFAULT 0 NOT NULL,
	"branded_excluded" boolean DEFAULT false NOT NULL,
	CONSTRAINT "ctr_curve_pk" PRIMARY KEY("account_id","fitted_at")
);
--> statement-breakpoint
CREATE TABLE "gsc_conns" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"property" text NOT NULL,
	"tokens" text NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "gsc_daily" (
	"account_id" uuid NOT NULL,
	"date" date NOT NULL,
	"page" text NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"position" numeric(6, 2),
	CONSTRAINT "gsc_daily_pk" PRIMARY KEY("account_id","date","page")
);
--> statement-breakpoint
CREATE TABLE "gsc_query_daily" (
	"account_id" uuid NOT NULL,
	"date" date NOT NULL,
	"page" text NOT NULL,
	"query" text NOT NULL,
	"device" text NOT NULL,
	"country" text NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"position" numeric(6, 2),
	CONSTRAINT "gsc_query_daily_pk" PRIMARY KEY("account_id","date","page","query","device","country")
);
--> statement-breakpoint
CREATE TABLE "query_clusters" (
	"cluster_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"head_query" text NOT NULL,
	"member_queries" text[] DEFAULT '{}'::text[] NOT NULL,
	"intent_class" "intent_class",
	"family_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "serp_snapshots" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"query" text NOT NULL,
	"locale" text NOT NULL,
	"results_json" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dismissed_opportunities" (
	"account_id" uuid NOT NULL,
	"signal_type" "signal_type" NOT NULL,
	"entity_ref" text NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"signal_type" "signal_type" NOT NULL,
	"entity_type" "opportunity_entity_type" NOT NULL,
	"entity_ref" text NOT NULL,
	"evidence_json" jsonb NOT NULL,
	"impact" "impact_band" NOT NULL,
	"impact_score" integer NOT NULL,
	"confidence" integer NOT NULL,
	"reason_template_key" text NOT NULL,
	"reason_params_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recommended_action" "recommended_action" NOT NULL,
	"preconditions_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "opportunity_status" DEFAULT 'new' NOT NULL,
	"limited_intelligence" boolean DEFAULT false NOT NULL,
	"topic_id" uuid,
	"article_id" uuid,
	"rules_version" text NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expired_reason" text,
	"applied_at" timestamp with time zone,
	"outcome_json" jsonb,
	"outcome_measured_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "opportunity_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"kind" "opportunity_task_kind" NOT NULL,
	"description" text NOT NULL,
	"suggested_copy_ref" text,
	"evidence_refs" text[] DEFAULT '{}'::text[] NOT NULL,
	"state" "opportunity_task_state" DEFAULT 'open' NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "optimize_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"page_url" text NOT NULL,
	"recommendation_json" jsonb NOT NULL,
	"judge_scores_json" jsonb,
	"prompt_version" text NOT NULL,
	"model_id" text NOT NULL,
	"rules_version" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" "optimize_recommendation_state" DEFAULT 'valid' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"locale" text,
	"page_type" text,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"kind" "signal_run_kind" NOT NULL,
	"rules_version" text NOT NULL,
	"signals_evaluated" integer DEFAULT 0 NOT NULL,
	"opportunities_created" integer DEFAULT 0 NOT NULL,
	"opportunities_updated" integer DEFAULT 0 NOT NULL,
	"opportunities_expired" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "landing_revenue_daily" (
	"account_id" uuid NOT NULL,
	"date" date NOT NULL,
	"landing_url" text NOT NULL,
	"orders_n" integer DEFAULT 0 NOT NULL,
	"revenue" numeric(14, 2) DEFAULT '0' NOT NULL,
	"currency" text NOT NULL,
	CONSTRAINT "landing_revenue_daily_pk" PRIMARY KEY("account_id","date","landing_url")
);
--> statement-breakpoint
CREATE TABLE "spend_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"preview_target" text,
	"vendor" "spend_vendor" NOT NULL,
	"call_type" text NOT NULL,
	"usd_cost" numeric(14, 8) NOT NULL,
	"cache_hit" boolean DEFAULT false NOT NULL,
	"outcome" "spend_outcome" NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_events_attribution_ck" CHECK (("spend_events"."account_id" IS NOT NULL AND "spend_events"."preview_target" IS NULL) OR ("spend_events"."account_id" IS NULL AND "spend_events"."preview_target" IS NOT NULL)),
	CONSTRAINT "spend_events_cost_nonnegative_ck" CHECK ("spend_events"."usd_cost" >= 0),
	CONSTRAINT "spend_events_cache_hit_is_free_ck" CHECK ("spend_events"."cache_hit" = false OR "spend_events"."usd_cost" = 0)
);
--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_facts" ADD CONSTRAINT "product_facts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_families" ADD CONSTRAINT "product_families_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_family_id_product_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."product_families"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "top_products" ADD CONSTRAINT "top_products_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "top_products" ADD CONSTRAINT "top_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keywords" ADD CONSTRAINT "keywords_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_pages" ADD CONSTRAINT "store_pages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ctr_curve" ADD CONSTRAINT "ctr_curve_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_conns" ADD CONSTRAINT "gsc_conns_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_daily" ADD CONSTRAINT "gsc_daily_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_query_daily" ADD CONSTRAINT "gsc_query_daily_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_clusters" ADD CONSTRAINT "query_clusters_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dismissed_opportunities" ADD CONSTRAINT "dismissed_opportunities_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_tasks" ADD CONSTRAINT "opportunity_tasks_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optimize_recommendations" ADD CONSTRAINT "optimize_recommendations_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules_overrides" ADD CONSTRAINT "rules_overrides_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_runs" ADD CONSTRAINT "signal_runs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_revenue_daily" ADD CONSTRAINT "landing_revenue_daily_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_families_account_idx" ON "product_families" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_account_shopify_id_key" ON "products" USING btree ("account_id","shopify_product_id");--> statement-breakpoint
CREATE INDEX "products_account_family_idx" ON "products" USING btree ("account_id","family_id");--> statement-breakpoint
CREATE INDEX "products_logical_product_idx" ON "products" USING btree ("logical_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "top_products_account_product_key" ON "top_products" USING btree ("account_id","product_id");--> statement-breakpoint
CREATE INDEX "top_products_account_rank_idx" ON "top_products" USING btree ("account_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "competitors_account_domain_key" ON "competitors" USING btree ("account_id","domain_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "keywords_account_term_key" ON "keywords" USING btree ("account_id","term");--> statement-breakpoint
CREATE INDEX "keywords_account_confirmed_idx" ON "keywords" USING btree ("account_id","confirmed");--> statement-breakpoint
CREATE UNIQUE INDEX "store_pages_account_url_key" ON "store_pages" USING btree ("account_id","url");--> statement-breakpoint
CREATE INDEX "store_pages_account_type_idx" ON "store_pages" USING btree ("account_id","page_type");--> statement-breakpoint
CREATE INDEX "store_pages_article_idx" ON "store_pages" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "gsc_daily_account_date_idx" ON "gsc_daily" USING btree ("account_id","date");--> statement-breakpoint
CREATE INDEX "gsc_query_daily_account_date_idx" ON "gsc_query_daily" USING btree ("account_id","date");--> statement-breakpoint
CREATE INDEX "gsc_query_daily_account_query_idx" ON "gsc_query_daily" USING btree ("account_id","query");--> statement-breakpoint
CREATE INDEX "query_clusters_account_head_idx" ON "query_clusters" USING btree ("account_id","head_query");--> statement-breakpoint
CREATE INDEX "serp_snapshots_expires_at_idx" ON "serp_snapshots" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dismissed_opportunities_key" ON "dismissed_opportunities" USING btree ("account_id","signal_type","entity_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunities_open_signal_entity_key" ON "opportunities" USING btree ("account_id","signal_type","entity_ref") WHERE "opportunities"."status" IN ('new', 'accepted', 'scheduled', 'executing', 'blocked');--> statement-breakpoint
CREATE INDEX "opportunities_account_status_idx" ON "opportunities" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "opportunities_account_rank_idx" ON "opportunities" USING btree ("account_id","impact_score","confidence");--> statement-breakpoint
CREATE INDEX "opportunities_rules_version_idx" ON "opportunities" USING btree ("rules_version");--> statement-breakpoint
CREATE INDEX "opportunity_tasks_opportunity_idx" ON "opportunity_tasks" USING btree ("opportunity_id","state");--> statement-breakpoint
CREATE INDEX "optimize_recommendations_opportunity_idx" ON "optimize_recommendations" USING btree ("opportunity_id","state");--> statement-breakpoint
CREATE INDEX "rules_overrides_key_idx" ON "rules_overrides" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "signal_runs_account_run_key" ON "signal_runs" USING btree ("account_id","run_id");--> statement-breakpoint
CREATE INDEX "landing_revenue_daily_account_date_idx" ON "landing_revenue_daily" USING btree ("account_id","date");--> statement-breakpoint
CREATE INDEX "spend_events_account_occurred_idx" ON "spend_events" USING btree ("account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "spend_events_vendor_occurred_idx" ON "spend_events" USING btree ("vendor","occurred_at");--> statement-breakpoint
CREATE INDEX "spend_events_preview_occurred_idx" ON "spend_events" USING btree ("occurred_at") WHERE "spend_events"."account_id" IS NULL;
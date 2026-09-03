CREATE TYPE "public"."article_label" AS ENUM('winner', 'neutral', 'underperformer', 'unrated');--> statement-breakpoint
CREATE TYPE "public"."article_state" AS ENUM('draft', 'in_review', 'published', 'rejected', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."claim_kind" AS ENUM('merchant_fact', 'external_fact', 'derived_fact', 'recommendation');--> statement-breakpoint
CREATE TYPE "public"."claim_staleness" AS ENUM('stable', 'seasonal', 'volatile');--> statement-breakpoint
CREATE TYPE "public"."pattern_dimension" AS ENUM('intent_class', 'family', 'keyword_cluster', 'action_type');--> statement-breakpoint
CREATE TYPE "public"."product_ref_field" AS ENUM('price', 'stock', 'sale_status', 'url', 'title');--> statement-breakpoint
CREATE TYPE "public"."product_ref_type" AS ENUM('link', 'recommendation', 'mention');--> statement-breakpoint
CREATE TYPE "public"."publish_intent_state" AS ENUM('pending', 'confirmed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."topic_kind" AS ENUM('new', 'refresh');--> statement-breakpoint
CREATE TYPE "public"."topic_source" AS ENUM('auto', 'manual', 'exploration');--> statement-breakpoint
CREATE TYPE "public"."topic_state" AS ENUM('planned', 'generating', 'in_review', 'published', 'rejected_by_gate', 'vetoed');--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'account_deletion_confirmed';--> statement-breakpoint
CREATE TABLE "incident_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ops_flag_id" uuid NOT NULL,
	"author" text NOT NULL,
	"finding" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deletion_confirmation_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"email" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"template_version" text NOT NULL,
	"state" "email_send_state" DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "gsc_monthly" (
	"account_id" uuid NOT NULL,
	"month" date NOT NULL,
	"page" text NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"position" numeric(6, 2),
	CONSTRAINT "gsc_monthly_pk" PRIMARY KEY("account_id","month","page")
);
--> statement-breakpoint
CREATE TABLE "gsc_query_monthly" (
	"account_id" uuid NOT NULL,
	"month" date NOT NULL,
	"page" text NOT NULL,
	"query" text NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"position" numeric(6, 2),
	CONSTRAINT "gsc_query_monthly_pk" PRIMARY KEY("account_id","month","page","query")
);
--> statement-breakpoint
CREATE TABLE "article_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"text" text NOT NULL,
	"kind" "claim_kind" NOT NULL,
	"confidence" "confidence_band" NOT NULL,
	"staleness" "claim_staleness" DEFAULT 'stable' NOT NULL,
	"evidence_json" jsonb NOT NULL,
	"sections" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_claims_evidence_nonempty_ck" CHECK (jsonb_typeof("article_claims"."evidence_json") = 'array' AND jsonb_array_length("article_claims"."evidence_json") >= 1)
);
--> statement-breakpoint
CREATE TABLE "article_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"label" "article_label" NOT NULL,
	"window_start" date NOT NULL,
	"window_end" date NOT NULL,
	"clicks" integer,
	"impressions" integer,
	"mean_position" numeric(6, 2),
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "article_product_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"product_id" uuid,
	"family_id" uuid,
	"ref_type" "product_ref_type" NOT NULL,
	"placeholder_key" text NOT NULL,
	"fields_rendered" "product_ref_field"[] NOT NULL,
	"resolved_values_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_product_refs_fields_nonempty_ck" CHECK (cardinality("article_product_refs"."fields_rendered") >= 1)
);
--> statement-breakpoint
CREATE TABLE "articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"target_keyword" text,
	"state" "article_state" DEFAULT 'draft' NOT NULL,
	"published_via_override" boolean DEFAULT false NOT NULL,
	"delivery" "delivery_mode" DEFAULT 'export' NOT NULL,
	"published_url" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gate_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"gate" smallint NOT NULL,
	"outcome" text NOT NULL,
	"scores_json" jsonb,
	"reason_user_facing" text,
	"prompt_version" text,
	"model_id" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gate_decisions_gate_range_ck" CHECK ("gate_decisions"."gate" IN (1, 2, 3))
);
--> statement-breakpoint
CREATE TABLE "not_interested" (
	"account_id" uuid NOT NULL,
	"topic_fingerprint" text NOT NULL,
	"vetoed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "not_interested_pk" PRIMARY KEY("account_id","topic_fingerprint")
);
--> statement-breakpoint
CREATE TABLE "pattern_stats" (
	"account_id" uuid NOT NULL,
	"dimension" "pattern_dimension" NOT NULL,
	"dimension_value" text NOT NULL,
	"rated_n" integer DEFAULT 0 NOT NULL,
	"winner_n" integer DEFAULT 0 NOT NULL,
	"underperformer_n" integer DEFAULT 0 NOT NULL,
	"multiplier" numeric(6, 4) DEFAULT '1' NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pattern_stats_pk" PRIMARY KEY("account_id","dimension","dimension_value")
);
--> statement-breakpoint
CREATE TABLE "publish_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_external_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"revision_n" integer DEFAULT 0 NOT NULL,
	"state" "publish_intent_state" DEFAULT 'pending' NOT NULL,
	"shopify_article_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "refresh_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"title" text NOT NULL,
	"target_keyword" text,
	"keyword_cluster" uuid,
	"intent_class" "intent_class" NOT NULL,
	"family_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"kind" "topic_kind" DEFAULT 'new' NOT NULL,
	"source" "topic_source" NOT NULL,
	"score" numeric(10, 4),
	"why_line" text,
	"scheduled_date" date NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"state" "topic_state" DEFAULT 'planned' NOT NULL,
	"veto_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "options" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "metafields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "spend_events" ADD COLUMN "article_id" uuid;--> statement-breakpoint
ALTER TABLE "incident_findings" ADD CONSTRAINT "incident_findings_ops_flag_id_ops_flags_id_fk" FOREIGN KEY ("ops_flag_id") REFERENCES "public"."ops_flags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_monthly" ADD CONSTRAINT "gsc_monthly_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_query_monthly" ADD CONSTRAINT "gsc_query_monthly_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_claims" ADD CONSTRAINT "article_claims_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_labels" ADD CONSTRAINT "article_labels_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_product_refs" ADD CONSTRAINT "article_product_refs_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_product_refs" ADD CONSTRAINT "article_product_refs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_product_refs" ADD CONSTRAINT "article_product_refs_family_id_product_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."product_families"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_decisions" ADD CONSTRAINT "gate_decisions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_decisions" ADD CONSTRAINT "gate_decisions_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "not_interested" ADD CONSTRAINT "not_interested_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pattern_stats" ADD CONSTRAINT "pattern_stats_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_intents" ADD CONSTRAINT "publish_intents_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_log" ADD CONSTRAINT "refresh_log_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_keyword_cluster_query_clusters_cluster_id_fk" FOREIGN KEY ("keyword_cluster") REFERENCES "public"."query_clusters"("cluster_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_findings_ops_flag_idx" ON "incident_findings" USING btree ("ops_flag_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deletion_confirmation_emails_account_dedupe_key" ON "deletion_confirmation_emails" USING btree ("account_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "gsc_monthly_account_month_idx" ON "gsc_monthly" USING btree ("account_id","month");--> statement-breakpoint
CREATE INDEX "gsc_query_monthly_account_month_idx" ON "gsc_query_monthly" USING btree ("account_id","month");--> statement-breakpoint
CREATE INDEX "article_claims_article_idx" ON "article_claims" USING btree ("article_id");--> statement-breakpoint
CREATE UNIQUE INDEX "article_labels_article_window_key" ON "article_labels" USING btree ("article_id","window_start","window_end");--> statement-breakpoint
CREATE UNIQUE INDEX "article_product_refs_article_placeholder_key" ON "article_product_refs" USING btree ("article_id","placeholder_key");--> statement-breakpoint
CREATE INDEX "article_product_refs_product_idx" ON "article_product_refs" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "articles_account_state_idx" ON "articles" USING btree ("account_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "articles_account_slug_key" ON "articles" USING btree ("account_id","slug");--> statement-breakpoint
CREATE INDEX "articles_topic_idx" ON "articles" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "gate_decisions_topic_idx" ON "gate_decisions" USING btree ("topic_id","gate");--> statement-breakpoint
CREATE INDEX "gate_decisions_account_decided_idx" ON "gate_decisions" USING btree ("account_id","decided_at");--> statement-breakpoint
CREATE UNIQUE INDEX "publish_intents_article_external_id_key" ON "publish_intents" USING btree ("article_external_id");--> statement-breakpoint
CREATE INDEX "publish_intents_pending_idx" ON "publish_intents" USING btree ("created_at") WHERE "publish_intents"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "refresh_log_article_refreshed_idx" ON "refresh_log" USING btree ("article_id","refreshed_at");--> statement-breakpoint
CREATE INDEX "topics_account_scheduled_idx" ON "topics" USING btree ("account_id","scheduled_date");--> statement-breakpoint
CREATE INDEX "topics_account_state_idx" ON "topics" USING btree ("account_id","state");--> statement-breakpoint
CREATE INDEX "topics_opportunity_idx" ON "topics" USING btree ("opportunity_id");--> statement-breakpoint
ALTER TABLE "store_pages" ADD CONSTRAINT "store_pages_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spend_events_article_idx" ON "spend_events" USING btree ("article_id","occurred_at") WHERE "spend_events"."article_id" IS NOT NULL;
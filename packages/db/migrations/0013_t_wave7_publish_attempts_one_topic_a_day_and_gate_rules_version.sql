CREATE TYPE "public"."publish_attempt_outcome" AS ENUM('succeeded', 'refused', 'uncertain', 'abandoned');--> statement-breakpoint
CREATE TABLE "publish_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"article_id" uuid,
	"article_external_id" text NOT NULL,
	"outcome" "publish_attempt_outcome" NOT NULL,
	"failure_class" text,
	"ended_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publish_attempts_failure_class_ck" CHECK (("publish_attempts"."outcome" = 'succeeded') = ("publish_attempts"."failure_class" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "gate_decisions" ADD COLUMN "rules_version" text;--> statement-breakpoint
-- Added in three steps rather than one so the migration cannot fail on a
-- database that already holds gate decisions. 'pre_stamping' is not a hash and
-- is not meant to look like one: it says this verdict was reached before we
-- began recording which thresholds produced it, which is the truth about every
-- row written before this wave and is better than inventing a version for them.
UPDATE "gate_decisions" SET "rules_version" = 'pre_stamping' WHERE "rules_version" IS NULL;--> statement-breakpoint
ALTER TABLE "gate_decisions" ALTER COLUMN "rules_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publish_attempts_ended_idx" ON "publish_attempts" USING btree ("ended_at");--> statement-breakpoint
CREATE INDEX "publish_attempts_account_ended_idx" ON "publish_attempts" USING btree ("account_id","ended_at");--> statement-breakpoint
CREATE UNIQUE INDEX "topics_account_live_day_key" ON "topics" USING btree ("account_id","scheduled_date") WHERE "topics"."state" <> 'vetoed';
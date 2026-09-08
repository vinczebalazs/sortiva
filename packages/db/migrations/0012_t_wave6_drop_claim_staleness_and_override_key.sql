ALTER TABLE "article_claims" DROP COLUMN "staleness";--> statement-breakpoint
DROP TYPE "public"."claim_staleness";--> statement-breakpoint
CREATE UNIQUE INDEX "rules_overrides_scope_key" ON "rules_overrides" ("account_id", "locale", "page_type", "key") NULLS NOT DISTINCT;

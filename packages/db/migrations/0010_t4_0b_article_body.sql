ALTER TABLE "articles" ADD COLUMN "body_json" jsonb;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "meta_description" text;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_body_json_object_ck" CHECK ("articles"."body_json" IS NULL OR jsonb_typeof("articles"."body_json") = 'object');
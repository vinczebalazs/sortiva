ALTER TYPE "public"."notification_type" ADD VALUE 'auto_publish_paused' BEFORE 'payment_failed';--> statement-breakpoint
ALTER TABLE "shopify_conns" ADD COLUMN "access_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shopify_conns" ADD COLUMN "refresh_token" text;--> statement-breakpoint
ALTER TABLE "shopify_conns" ADD COLUMN "refresh_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shopify_conns" ADD COLUMN "storefront_host" text;--> statement-breakpoint
ALTER TABLE "shopify_conns" ADD COLUMN "shop_name" text;--> statement-breakpoint
ALTER TABLE "shopify_conns" ADD COLUMN "publish_granted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_steps" ADD COLUMN "last_error_class" text;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "images" jsonb DEFAULT '[]'::jsonb NOT NULL;
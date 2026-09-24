ALTER TYPE "public"."subscription_status" ADD VALUE 'comped' BEFORE 'past_due';--> statement-breakpoint
ALTER TABLE "subscriptions" ALTER COLUMN "stripe_subscription_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ALTER COLUMN "price_id" DROP NOT NULL;
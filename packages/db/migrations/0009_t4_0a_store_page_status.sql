CREATE TYPE "public"."store_page_status" AS ENUM('live', 'gone');--> statement-breakpoint
ALTER TABLE "store_pages" ADD COLUMN "status" "store_page_status" DEFAULT 'live' NOT NULL;
CREATE TABLE "job_dlq" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"job_id" uuid,
	"step_id" uuid,
	"step" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"error_class" text NOT NULL,
	"last_error" text NOT NULL,
	"attempts" integer NOT NULL,
	"input_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_failed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replayed_at" timestamp with time zone,
	"replayed_by" text
);
--> statement-breakpoint
ALTER TABLE "job_dlq" ADD CONSTRAINT "job_dlq_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_dlq" ADD CONSTRAINT "job_dlq_job_id_ingestion_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ingestion_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_dlq" ADD CONSTRAINT "job_dlq_step_id_job_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."job_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_dlq_open_idx" ON "job_dlq" USING btree ("created_at") WHERE "job_dlq"."replayed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "job_dlq_account_idx" ON "job_dlq" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "job_dlq_idempotency_key_idx" ON "job_dlq" USING btree ("idempotency_key");
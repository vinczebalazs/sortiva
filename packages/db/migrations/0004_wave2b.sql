CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_tokens_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "idempotency_ledger" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"output_ref" jsonb,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "verification_tokens_token_key" ON "verification_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "verification_tokens_expires_idx" ON "verification_tokens" USING btree ("expires");--> statement-breakpoint
CREATE INDEX "idempotency_ledger_completed_at_idx" ON "idempotency_ledger" USING btree ("completed_at");
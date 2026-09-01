-- Card T1.2a — billing remediation. A sanctioned wave exception: this migration
-- carries only the two schema gaps the founder asked for, both of which fix a
-- silent failure in card T1.2's billing code.

-- ── 1. `incomplete` becomes its own status ──────────────────────────────────
--
-- Stripe distinguishes a merchant whose first payment is still being authorised
-- (`incomplete`) from one whose authorisation window ran out
-- (`incomplete_expired`). T1.2 mapped both onto `incomplete_expired`, which
-- records a merchant mid-purchase as one who gave up — and then reports them as
-- churn on main §14.7's `subscription_canceled` funnel event from the moment
-- their row is created.
--
-- Neither status is entitled (main §4.2, "Entitled = `active`"), so nothing
-- about gating changes. main §4.2 and §13 both enumerate four values; this is a
-- founder-directed fifth and the spec text needs the matching edit.
ALTER TYPE "public"."subscription_status" ADD VALUE 'incomplete' BEFORE 'incomplete_expired';--> statement-breakpoint

-- ── 2. The ordering key stops sharing a column with the staleness clock ─────
--
-- T1.2 had `synced_at` carry two meanings at once: tech §3's "when did we last
-- check with Stripe" (which the nightly reconciliation scans for rows stale
-- >24h) and the monotonic guard that makes an out-of-order webhook a no-op
-- instead of a rollback. Two consequences, both silent:
--
--   a) Writing `now()` to `synced_at` — the obvious thing for a future author
--      to do to mean "freshly checked" — sets the ordering floor to the
--      present, so every subsequent webhook is discarded as stale and the
--      account's billing status freezes for good. No error, no log.
--   b) Under the old meaning `synced_at` held Stripe's `created`, so a healthy
--      subscription that has not changed in months looks permanently stale and
--      the nightly job re-syncs the entire customer base every night, capped at
--      500 accounts — a growth cliff that fails quietly.
--
-- So the guard gets its own column and `synced_at` goes back to meaning what
-- tech §3 says it means.
ALTER TABLE "subscriptions" ADD COLUMN "state_observed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint

-- The default would stamp every existing row with the migration's own clock,
-- setting each account's ordering floor to *now* — exactly failure (a) above,
-- inflicted on the whole customer base at once. Existing rows already hold the
-- old ordering key in `synced_at`, so carry it across verbatim.
UPDATE "subscriptions" SET "state_observed_at" = "synced_at";--> statement-breakpoint

COMMENT ON COLUMN "subscriptions"."state_observed_at" IS
  'The instant we read this state from Stripe, and the monotonic guard on the upsert. Writing now() here on any path that did not just re-read this subscription from Stripe freezes the account''s billing status: every later webhook is then discarded as stale, silently. Only the guarded upsert may write it.';--> statement-breakpoint

COMMENT ON COLUMN "subscriptions"."synced_at" IS
  'When we last successfully contacted Stripe about this row (tech §3 scans it for rows stale >24h). Safe to advance on any successful contact; it is not the ordering key.';

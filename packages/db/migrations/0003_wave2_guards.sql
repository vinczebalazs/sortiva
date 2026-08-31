-- Schema wave 2, part 2: the two guarantees drizzle-kit cannot express.
-- Hand-written, so it is a `--custom` migration rather than a generated diff.
--
-- Both are constraints the product's correctness rests on, and both must hold
-- against a hand-written INSERT, not only against our repositories.

-- ── 1. main §6.6 / invariant 5 — at most five business competitors ──────────
--
-- "the cap is enforced in the API and DB (application-level check + count
-- constraint), not just the UI, because competitor count directly drives
-- DataForSEO cost in topic discovery and the learning loop."
--
-- A trigger that merely counts is not a constraint: under READ COMMITTED two
-- concurrent inserts each see five rows, each allow a sixth, and the account
-- ends with seven. Locking the account row first serialises inserts for that
-- account, so the count is taken with no other insert in flight. The lock is
-- held to end of transaction and competitor edits are rare, so the cost is
-- nothing.

CREATE OR REPLACE FUNCTION enforce_competitor_cap() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  existing integer;
BEGIN
  PERFORM 1 FROM accounts WHERE id = NEW.account_id FOR UPDATE;

  SELECT count(*) INTO existing
  FROM competitors
  WHERE account_id = NEW.account_id
    AND id IS DISTINCT FROM NEW.id;

  IF existing >= 5 THEN
    RAISE EXCEPTION
      'account % already has % business competitors; the cap is 5 (main §6.6)',
      NEW.account_id, existing
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER competitors_cap_trg
BEFORE INSERT OR UPDATE OF account_id ON competitors
FOR EACH ROW EXECUTE FUNCTION enforce_competitor_cap();
--> statement-breakpoint

-- ── 2. remediation D1 — the spend ledger is append-only ─────────────────────
--
-- A record of money spent is never revised: a wrong number is corrected by a
-- second row, so the history of what we believed stays readable. DELETE is left
-- alone because tech §2.1 gives a retention sweep the job of keeping Postgres
-- small, and the §14.5 caps only ever read a trailing window.

CREATE OR REPLACE FUNCTION reject_spend_event_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'spend_events is append-only: correct a cost with a new row, never an update'
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER spend_events_append_only_trg
BEFORE UPDATE ON spend_events
FOR EACH ROW EXECUTE FUNCTION reject_spend_event_update();

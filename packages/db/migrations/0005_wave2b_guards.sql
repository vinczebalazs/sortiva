-- Schema mini-wave 2b, part 2: the one guarantee drizzle-kit cannot express.
-- Hand-written, so it is a `--custom` migration rather than a generated diff.
-- Same shape as 0003_wave2_guards.sql, which does this for `spend_events`.

-- ── idempotency_ledger is write-once (main §14.3.2) ─────────────────────────
--
-- "Completed keys are stored with their output reference; a worker seeing a
-- completed key returns the stored output without executing." If the stored
-- output could be revised, a replay could return a different answer than the
-- run it is resuming — §14.3.6 names that hazard directly for LLM calls ("a
-- retried step replays the stored completion rather than re-sampling ... which
-- also guarantees a retry can't get a *different* persona than the run it's
-- resuming").
--
-- So recording a completion is an insert with ON CONFLICT DO NOTHING, never an
-- upsert: the first worker to finish the work owns the answer. DELETE is left
-- alone because tech §2.1 gives a retention sweep the job of keeping Postgres
-- small — but pruning here must be by age, never by job or by account, and only
-- past the point where the queue could still redeliver the work.

CREATE OR REPLACE FUNCTION reject_idempotency_ledger_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'idempotency_ledger is write-once: a completed key''s stored output never changes (main §14.3.2)'
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER idempotency_ledger_write_once_trg
BEFORE UPDATE ON idempotency_ledger
FOR EACH ROW EXECUTE FUNCTION reject_idempotency_ledger_update();

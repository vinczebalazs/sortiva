import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * The durable record of "this work is already done".
 *
 * Completed keys are stored with their output. A worker that sees a completed
 * key returns that output without executing, so "have I done this work" and
 * "where is the result" are one lookup rather than two.
 *
 * The queue delivers at least once, so that lookup is the only thing standing
 * between a redelivered message and a
 * second real execution — a second billed Shopify crawl, a second billed batch
 * of LLM calls.
 *
 * Today that lookup reads `job_steps` itself (`lookupCompletedKey`,
 * `packages/jobs/src/runtime/steps.ts`), so the evidence of completed work is
 * only as durable as the job row: `job_steps` cascades from `ingestion_jobs`,
 * which cascades from `accounts`, and the daily retention sweep registered in
 * the crontab still has no handler. Delete the step row — by a retention sweep,
 * a "restart onboarding" feature, or an account cascade — and a replay executes
 * for real. `docs/audits/T0.4.md` traced every current deletion path and found
 * the risk unrealised but live; `docs/audits/remediation.md` D7 item 2 is the
 * decision to take the structural fix.
 *
 * **The absence of a foreign key is the entire design.** A key that cascades
 * from a job is precisely what goes wrong today, so this table references
 * nothing: `spend_events` in the same package is account-less for the same
 * class of reason (deleting the payer must not erase the record of the
 * payment). `idempotency_key` is `sha256(account_id ‖ step_name ‖
 * input_version)` — opaque by construction, and carrying no account column is
 * what makes an account cascade unable to reach it.
 *
 * Immutable once written: a completed key's stored output never changes, or a
 * replay could return a different answer than the run it is resuming.
 * `migrations/0005_wave2b_guards.sql` makes the database refuse `UPDATE`, so
 * recording a completion is `ON CONFLICT DO NOTHING`, never an upsert. `DELETE`
 * is left open on the same terms as `spend_events`, so the retention sweep can
 * keep Postgres small — but pruning here must be
 * by age, never by job or account, and only past the point where the work could
 * still be redelivered.
 *
 * **Nothing reads or writes this table yet.** Moving the worker runtime onto it
 * is a follow-up card: `packages/jobs/src/runtime` belongs to card `R1`, which
 * was in flight when this migration was written. Until that card lands, the
 * ledger of record is still `job_steps`.
 */
export const idempotencyLedger = pgTable(
  'idempotency_ledger',
  {
    /** Derived from the step's inputs, never random, so a retry arrives at the same key. */
    idempotencyKey: text('idempotency_key').primaryKey(),
    /**
     * What the completed work produced. `jsonb` and nullable, matching
     * `job_steps.output_ref`: there is no blob store, so the payload is inline,
     * and a step that completes with nothing to hand back stores null. Row
     * presence, not this column, answers "was it done".
     */
    outputRef: jsonb('output_ref'),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Age-based retention (see above) scans this; nothing else orders by time.
  (t) => [index('idempotency_ledger_completed_at_idx').on(t.completedAt)],
)

import { sql } from 'drizzle-orm'
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { accounts } from './accounts'
import { ingestionJobs, jobSteps } from './jobs'

/**
 * main §14.3.5 — "DLQ entries carry the full replay context: step, idempotency
 * key, input refs, last error, attempt timestamps. Ops can replay a DLQ item
 * with one action *because* idempotency makes replay safe."
 *
 * main §13 lists no table for this and T0.4's done-when requires one ("DLQ entry
 * carries step + key + error"), so it lands as a wave-1 addendum — see
 * DECISIONS 2026-08-27 T0.4.
 *
 * `job_id` / `step_id` are nullable because not all dead-lettered work is an
 * ingestion step: publish, sweeps and email sends are Graphile jobs with the
 * same retry policy (§14.3.5) and the same need for a replayable record.
 */
export const jobDlq = pgTable(
  'job_dlq',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').references(() => ingestionJobs.id, { onDelete: 'set null' }),
    stepId: uuid('step_id').references(() => jobSteps.id, { onDelete: 'set null' }),
    /** The step or task name. Text, not the `job_step` enum, so non-ingestion tasks fit. */
    step: text('step').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    /** The typed failure class (§14.3.5), e.g. `token_revoked`, `schema_invalid`. */
    errorClass: text('error_class').notNull(),
    lastError: text('last_error').notNull(),
    attempts: integer('attempts').notNull(),
    /** Enough to re-run: the checkpoint cursor, the payload, upstream artefact ids. */
    inputRefs: jsonb('input_refs').notNull().default(sql`'{}'::jsonb`),
    /** §14.3.5 "attempt timestamps". */
    firstFailedAt: timestamp('first_failed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    replayedAt: timestamp('replayed_at', { withTimezone: true }),
    replayedBy: text('replayed_by'),
  },
  (t) => [
    // main §14.7 — "DLQ depth > 0 for > 1h alerts"; depth is the open rows.
    index('job_dlq_open_idx')
      .on(t.createdAt)
      .where(sql`${t.replayedAt} IS NULL`),
    index('job_dlq_account_idx').on(t.accountId, t.createdAt),
    index('job_dlq_idempotency_key_idx').on(t.idempotencyKey),
  ],
)

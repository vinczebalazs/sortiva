import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { accounts } from './accounts'
import {
  ingestionJobStatusEnum,
  jobStepEnum,
  jobStepStateEnum,
  opsFlagScopeEnum,
  opsFlagTrippedByEnum,
  webhookSourceEnum,
  webhookStatusEnum,
} from './enums'

/** One row per ingestion run for one store. */
export const ingestionJobs = pgTable(
  'ingestion_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    status: ingestionJobStatusEnum('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('ingestion_jobs_account_run_key').on(t.accountId, t.runId),
    index('ingestion_jobs_account_status_idx').on(t.accountId, t.status),
  ],
)

/**
 * One step of one ingestion run.
 *
 * Transitions are guarded updates (`UPDATE ... WHERE state = 'expected'`), so
 * two workers handed the same step cannot both proceed: whichever loses matches
 * zero rows and stops. `idempotency_key` is derived from the step's inputs and
 * never random, so a redelivery arrives at the same key, and `output_ref` holds
 * the answer that key already produced — see DECISIONS 2026-08-27 T0.3.
 */
export const jobSteps = pgTable(
  'job_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => ingestionJobs.id, { onDelete: 'cascade' }),
    step: jobStepEnum('step').notNull(),
    state: jobStepStateEnum('state').notNull().default('pending'),
    idempotencyKey: text('idempotency_key').notNull(),
    outputRef: jsonb('output_ref'),
    // Where a long step got to. Anything that can run past a minute saves its
    // position here, so a deploy or a crash resumes rather than restarts.
    checkpoint: jsonb('checkpoint'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    // When to try again after a retryable failure: 1m, then 5m, then 25m, each
    // with jitter so a whole cohort of failures does not retry in lockstep.
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One row per step per run; re-dispatching a run reuses these rows.
    uniqueIndex('job_steps_job_step_key').on(t.jobId, t.step),
    // "Has this work been done, and where is the result" is one lookup rather
    // than two. Not unique — a later run legitimately creates
    // another row for the same key; the worker consults the ledger first.
    index('job_steps_idempotency_key_idx').on(t.idempotencyKey),
    index('job_steps_dispatch_idx').on(t.state, t.nextAttemptAt),
  ],
)

/**
 * Answers we have already paid for: SEO-vendor reads and LLM calls, keyed on
 * the canonical request rather than on anything random.
 *
 * The row is written **before** the answer is processed, so a crash between
 * "the vendor answered" and "we finished with it" does not make us buy the same
 * answer twice. Postgres is the cache — there is no Redis and no blob store in
 * V1 — so the payload is inline JSONB rather than a reference; see DECISIONS
 * 2026-08-27 T0.3.
 */
export const requestCache = pgTable(
  'request_cache',
  {
    cacheKey: text('cache_key').primaryKey(),
    // `llm` | `dataforseo` | ... — lets the retention sweep and the cost
    // dashboards tell the two kinds of paid call apart.
    kind: text('kind').notNull(),
    responseJson: jsonb('response_json').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('request_cache_expires_at_idx').on(t.expiresAt)],
)

/**
 * The kill switches and spend trips, as rows.
 *
 * These are enforced from this table and our own counters, in our own code.
 * Analytics observes a trip; it never causes or gates one, because a control
 * plane that lives at a vendor stops working exactly when we most need it.
 * A flag is active while `reset_at IS NULL`.
 */
export const opsFlags = pgTable(
  'ops_flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: opsFlagScopeEnum('scope').notNull(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    flag: text('flag').notNull(),
    actor: text('actor').notNull(),
    reason: text('reason').notNull(),
    trippedBy: opsFlagTrippedByEnum('tripped_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resetAt: timestamp('reset_at', { withTimezone: true }),
    resetBy: text('reset_by'),
  },
  (t) => [
    // At most one active global flag of a given name...
    uniqueIndex('ops_flags_active_global_key')
      .on(t.flag)
      .where(sql`${t.resetAt} IS NULL AND ${t.scope} = 'global'`),
    // ...and at most one active account flag of a given name per account.
    uniqueIndex('ops_flags_active_account_key')
      .on(t.accountId, t.flag)
      .where(sql`${t.resetAt} IS NULL AND ${t.scope} = 'account'`),
    // Read at every job dequeue, so flipping a switch has to take effect in
    // seconds; this index is what keeps that read cheap.
    index('ops_flags_active_idx')
      .on(t.scope, t.flag)
      .where(sql`${t.resetAt} IS NULL`),
    // A global flag has no account; an account flag must have one.
    check(
      'ops_flags_scope_account_ck',
      sql`(${t.scope} = 'global' AND ${t.accountId} IS NULL) OR (${t.scope} = 'account' AND ${t.accountId} IS NOT NULL)`,
    ),
  ],
)

/**
 * What an operator found when they looked into a trip.
 *
 * `ops_flags` already answers "what raised this and when" — an open incident
 * *is* an active flag row (DECISIONS 2026-09-02 T8.4a). What it cannot hold is
 * the other half: what a human learned after going and looking, which may
 * arrive well after the trip and may be more than one note as the
 * investigation continues. Added by schema wave 3 (T4.0), collected from the
 * gap `T8.4` recorded when it declined to build a separate incidents table on
 * its own authority. Not append-only like `spend_events` or
 * `idempotency_ledger`: a note correcting a typo in an operator's own finding
 * is not the same hazard as revising a financial record or a completed job's
 * output.
 */
export const incidentFindings = pgTable(
  'incident_findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    opsFlagId: uuid('ops_flag_id')
      .notNull()
      .references(() => opsFlags.id, { onDelete: 'cascade' }),
    /** Who looked into it — an operator identity, not a system actor. */
    author: text('author').notNull(),
    finding: text('finding').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('incident_findings_ops_flag_idx').on(t.opsFlagId, t.createdAt)],
)

/**
 * Every webhook we have received, before anything is done about it.
 *
 * `webhook_id` is the primary key and receipt is insert-or-ignore, so a
 * redelivery is free. Processing then reads from this table and never from the
 * request body, which is what lets the receiver answer 200 immediately and do
 * the work afterwards. `source` is ours rather than the spec's — see DECISIONS
 * 2026-08-27 T0.3.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    webhookId: text('webhook_id').primaryKey(),
    source: webhookSourceEnum('source').notNull(),
    topic: text('topic').notNull(),
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    status: webhookStatusEnum('status').notNull().default('received'),
    lastError: text('last_error'),
  },
  (t) => [
    index('webhook_events_unprocessed_idx')
      .on(t.receivedAt)
      .where(sql`${t.processedAt} IS NULL`),
    // The retention sweep prunes payloads at 30 days by arrival time.
    index('webhook_events_received_at_idx').on(t.receivedAt),
  ],
)

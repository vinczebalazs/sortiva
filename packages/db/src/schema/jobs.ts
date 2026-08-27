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

/** main §13 `ingestion_jobs`, §14.3.1 — one row per (account, run). */
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
 * main §13 `job_steps`, §14.3.1–14.3.4.
 *
 * Transitions are guarded updates (`UPDATE ... WHERE state = 'expected'`);
 * a worker whose guard matches zero rows stops immediately (invariant 18).
 * `idempotency_key` is derived from inputs, never random (§14.3.2), and
 * `output_ref` is the "stored output" half of the completed-key ledger — see
 * DECISIONS 2026-08-27 T0.3, main §13 does not list that column.
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
    // main §14.3.4 — any step that can exceed 60 seconds must checkpoint.
    checkpoint: jsonb('checkpoint'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    // main §14.3.5 — 1m / 5m / 25m with ±20% jitter.
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One row per step per run; re-dispatching a run reuses these rows.
    uniqueIndex('job_steps_job_step_key').on(t.jobId, t.step),
    // §14.3.2 "the cache is the ledger": has this work been done, and where is
    // the result, are one lookup. Not unique — a later run legitimately creates
    // another row for the same key; the worker consults the ledger first.
    index('job_steps_idempotency_key_idx').on(t.idempotencyKey),
    index('job_steps_dispatch_idx').on(t.state, t.nextAttemptAt),
  ],
)

/**
 * main §13 `request_cache`, §14.3.6.
 *
 * Billable reads (DataForSEO) and LLM calls, keyed on canonical params /
 * `(prompt_version, model_id, sha256(prompt))`, **written before processing**
 * (invariant 20). §13 names the payload column `response_ref`; there is no blob
 * store in V1 (tech §2.1: no Redis, Postgres is the cache), so it is realised
 * as an inline JSONB payload — DECISIONS 2026-08-27 T0.3.
 */
export const requestCache = pgTable(
  'request_cache',
  {
    cacheKey: text('cache_key').primaryKey(),
    // `llm` | `dataforseo` | ... — lets the retention sweep and the cost
    // dashboards separate the two classes §14.3.6 distinguishes.
    kind: text('kind').notNull(),
    responseJson: jsonb('response_json').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('request_cache_expires_at_idx').on(t.expiresAt)],
)

/**
 * main §13 `ops_flags`, §14.5.
 *
 * Invariant 17: spend caps are enforced from `ops_flags` / DB counters in our
 * code. PostHog observes trips; it never causes or gates them (main §14.7).
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
    // main §14.5 — checked at job dequeue, effective within 60s.
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
 * main §13 `webhook_events`, §14.3.8.
 *
 * `webhook_id` is unique; insert-or-ignore, then process from the table, never
 * from the request body directly. `source` is not in §13 — see DECISIONS
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
    // tech §2.1 — payloads pruned at 30 days.
    index('webhook_events_received_at_idx').on(t.receivedAt),
  ],
)

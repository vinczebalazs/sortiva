import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { jobDlq, jobSteps, type Db } from '@sortiva/db'

export type DlqEntry = typeof jobDlq.$inferSelect

/**
 * main §14.3.5 — "DLQ entries carry the full replay context: step, idempotency
 * key, input refs, last error, attempt timestamps. Ops can replay a DLQ item
 * with one action *because* idempotency makes replay safe — completed sub-work
 * no-ops, only the failed remainder executes."
 */
export interface DlqInput {
  accountId?: string
  jobId?: string
  stepId?: string
  step: string
  idempotencyKey: string
  errorClass: string
  lastError: string
  attempts: number
  /** The checkpoint cursor, the task payload, upstream artefact ids — whatever a replay needs. */
  inputRefs?: Record<string, unknown>
  firstFailedAt: Date
}

export async function deadLetter(db: Db, input: DlqInput): Promise<DlqEntry> {
  const [row] = await db
    .insert(jobDlq)
    .values({
      accountId: input.accountId ?? null,
      jobId: input.jobId ?? null,
      stepId: input.stepId ?? null,
      step: input.step,
      idempotencyKey: input.idempotencyKey,
      errorClass: input.errorClass,
      lastError: input.lastError,
      attempts: input.attempts,
      inputRefs: input.inputRefs ?? {},
      firstFailedAt: input.firstFailedAt,
    })
    .returning()
  if (!row) throw new Error('failed to write DLQ entry')
  return row
}

/** main §14.7 — "DLQ depth > 0 for > 1h alerts". */
export async function dlqDepth(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobDlq)
    .where(isNull(jobDlq.replayedAt))
  return row?.n ?? 0
}

export async function listOpenDlq(db: Db, limit = 100): Promise<DlqEntry[]> {
  return db
    .select()
    .from(jobDlq)
    .where(isNull(jobDlq.replayedAt))
    .orderBy(desc(jobDlq.createdAt))
    .limit(limit)
}

/**
 * main §14.3.5 — "Ops can replay a DLQ item with one action *because*
 * idempotency makes replay safe — completed sub-work no-ops, only the failed
 * remainder executes."
 *
 * Marks the entry replayed and returns its step to `pending`, so the normal
 * dispatcher picks it up. The step keeps its checkpoint, and the idempotency
 * ledger means completed sub-work no-ops.
 *
 * The outcome is explicit rather than a bare row, because two of the three cases
 * look like success and are not:
 *
 *  - `already_replayed` — the guarded update matched nothing, so a double click
 *    is a no-op rather than a second run.
 *  - `step_missing` — the entry outlived its step row (`job_dlq.step_id` is
 *    `ON DELETE set null`), or it was never an ingestion step at all (publish,
 *    sweeps and email sends dead-letter here too). There is nothing to
 *    reschedule, and an operator must be told that rather than shown a green
 *    tick over a button that did nothing.
 */
export type DlqReplayOutcome =
  | { status: 'replayed'; entry: DlqEntry }
  | { status: 'already_replayed' }
  | { status: 'step_missing'; entry: DlqEntry }

export async function replayDlqEntry(
  db: Db,
  dlqId: string,
  replayedBy: string,
): Promise<DlqReplayOutcome> {
  const [entry] = await db
    .update(jobDlq)
    .set({ replayedAt: new Date(), replayedBy })
    .where(and(eq(jobDlq.id, dlqId), isNull(jobDlq.replayedAt)))
    .returning()
  if (!entry) return { status: 'already_replayed' }

  if (!entry.stepId) return { status: 'step_missing', entry }

  const [reset] = await db
    .update(jobSteps)
    .set({ state: 'pending', attempts: 0, nextAttemptAt: null, updatedAt: new Date() })
    .where(eq(jobSteps.id, entry.stepId))
    .returning({ id: jobSteps.id })
  if (!reset) return { status: 'step_missing', entry }

  return { status: 'replayed', entry }
}

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
 * main §14.3.5 — the one-action replay. Marks the entry replayed and returns
 * the step to `pending`, so the normal dispatcher picks it up. The step keeps
 * its checkpoint, and the idempotency ledger means completed sub-work no-ops.
 *
 * Returns `undefined` when the entry was already replayed — the guarded update
 * makes a double click a no-op rather than a second run.
 */
export async function replayDlqEntry(
  db: Db,
  dlqId: string,
  replayedBy: string,
): Promise<DlqEntry | undefined> {
  const [entry] = await db
    .update(jobDlq)
    .set({ replayedAt: new Date(), replayedBy })
    .where(and(eq(jobDlq.id, dlqId), isNull(jobDlq.replayedAt)))
    .returning()
  if (!entry) return undefined

  if (entry.stepId) {
    await db
      .update(jobSteps)
      .set({ state: 'pending', attempts: 0, nextAttemptAt: null, updatedAt: new Date() })
      .where(eq(jobSteps.id, entry.stepId))
  }
  return entry
}

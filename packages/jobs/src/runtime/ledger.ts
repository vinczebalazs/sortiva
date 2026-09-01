import { eq } from 'drizzle-orm'
import { idempotencyLedger, type Db } from '@sortiva/db'

/**
 * Completed keys are stored with their output. A worker that sees a completed
 * key returns that output without executing, so "have I done this work" and
 * "where is the result" are one lookup rather than two.
 *
 * The queue delivers at least once, so this lookup is the only thing between
 * a redelivered message and a second real execution — a second billed Shopify
 * crawl, a second billed batch of LLM calls. Until this file existed the lookup
 * read `job_steps` (`lookupCompletedKey`, removed from `steps.ts`), which
 * cascades from `ingestion_jobs` and from `accounts`: delete the run and the
 * evidence went with it. `idempotency_ledger` references nothing, so no cascade,
 * retention sweep or "restart onboarding" can reach it (`docs/audits/T0.4.md`
 * [major]; `docs/audits/remediation.md` D7 item 2; DECISIONS 2026-08-31 T2.0b).
 *
 * Two rules the table enforces in the database, not here:
 *   - `UPDATE` raises (`migrations/0005_wave2b_guards.sql`), so a completed
 *     key's stored output can never be revised — a replay cannot get a
 *     different answer than the run it is resuming.
 *   - `idempotency_key` is the primary key, so the first writer of a key owns
 *     its answer and every later writer conflicts.
 */

/** What the ledger holds for one key. `outputRef` is null for work with no result. */
export interface CompletedWork {
  outputRef: unknown
}

export interface RecordedWork extends CompletedWork {
  /**
   * False when this key was already in the ledger — the work ran twice, or a
   * previous attempt recorded it and died before marking its step. Either way
   * the stored answer wins, and `outputRef` is that answer, not the caller's.
   */
  firstWriter: boolean
}

/**
 * "Have I already done this work?" — the whole of the short-circuit.
 * `undefined` means no record: the work has not been completed under this key.
 */
export async function lookupCompletedWork(
  db: Db,
  idempotencyKey: string,
): Promise<CompletedWork | undefined> {
  const [row] = await db
    .select({ outputRef: idempotencyLedger.outputRef })
    .from(idempotencyLedger)
    .where(eq(idempotencyLedger.idempotencyKey, idempotencyKey))
    .limit(1)
  return row ? { outputRef: row.outputRef } : undefined
}

/**
 * Records that this key's work is finished, with its output.
 *
 * Insert-or-nothing, never an upsert: the table refuses `UPDATE` outright, and
 * the reason is that a revisable answer would let a replay return
 * something other than what the run it is resuming produced. So a conflict is
 * not an error, it is the first writer keeping its answer; we read that answer
 * back and hand it to the caller so the ledger, the step row and the returned
 * value cannot disagree.
 */
export async function recordCompletedWork(
  db: Db,
  idempotencyKey: string,
  output: unknown,
): Promise<RecordedWork> {
  const [inserted] = await db
    .insert(idempotencyLedger)
    .values({ idempotencyKey, outputRef: (output ?? null) as never })
    .onConflictDoNothing({ target: idempotencyLedger.idempotencyKey })
    .returning({ outputRef: idempotencyLedger.outputRef })

  if (inserted) return { outputRef: inserted.outputRef, firstWriter: true }

  const stored = await lookupCompletedWork(db, idempotencyKey)
  // Only reachable if the winning row was deleted between the two statements,
  // which retention must never do inside the redelivery window (see the table's
  // comment in packages/db/src/schema/idempotency.ts).
  if (!stored) throw new Error(`idempotency ledger lost the record for key ${idempotencyKey}`)
  return { outputRef: stored.outputRef, firstWriter: false }
}

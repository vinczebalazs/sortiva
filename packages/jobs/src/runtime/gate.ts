import type { Db } from '@sortiva/db'
import { isAccountFlagActive, isGlobalFlagActive, accountScope, systemScope } from '@sortiva/db'
import { ACCOUNT_PAUSED_FLAG, ALL_WORK_PAUSED_FLAG, type Logger } from '@sortiva/core'
import { runtimeLogger } from './logging'

/**
 * The one question every dispatcher asks before it starts an account's work:
 * may this run?
 *
 * There is exactly one of these on purpose. Kill switches are worthless if half
 * the code paths consult them and half do not, and a second implementation
 * somewhere else would give the product two answers to the same question.
 *
 * It covers work that can spend money on an account's behalf — catalogue
 * ingestion, distillation, enrichment, article generation. Publishing has its
 * own switches and is not decided here.
 */

export type WorkGateDecision =
  | { readonly allowed: true }
  /** A switch is up. `flag` says which, so the caller can log or show it. */
  | { readonly allowed: false; readonly reason: 'paused'; readonly flag: string }
  /** The switches could not be read at all. */
  | { readonly allowed: false; readonly reason: 'unreadable'; readonly detail: string }

const ALLOWED: WorkGateDecision = { allowed: true }

/**
 * Answers from the database on every call — no cache, no in-memory copy — so
 * flipping a switch takes effect on the next job rather than whenever a cache
 * happens to expire.
 *
 * **When the database cannot be reached it answers no.** That is the deliberate
 * direction: the alternative, treating an unreadable switch as "carry on", means
 * the one condition under which the brakes silently stop existing is a database
 * problem — and a database problem is exactly when a runaway is most plausible.
 * It costs nothing in practice, because the work being gated reads and writes
 * the same database and would fail moments later anyway; what it buys is that
 * no paid vendor call is ever made on the strength of a switch we could not
 * read.
 */
export async function mayAccountWorkRun(
  db: Db,
  accountId: string,
  log: Logger = runtimeLogger(),
): Promise<WorkGateDecision> {
  try {
    const system = systemScope('kill switches are global by definition; this one has no account')
    if (await isGlobalFlagActive(db, system, ALL_WORK_PAUSED_FLAG)) {
      return { allowed: false, reason: 'paused', flag: ALL_WORK_PAUSED_FLAG }
    }
    if (await isAccountFlagActive(db, accountScope(accountId), ACCOUNT_PAUSED_FLAG)) {
      return { allowed: false, reason: 'paused', flag: ACCOUNT_PAUSED_FLAG }
    }
    return ALLOWED
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    log.error('kill_switch_unreadable', { account_id: accountId, error_class: 'db_unavailable' })
    return { allowed: false, reason: 'unreadable', detail }
  }
}

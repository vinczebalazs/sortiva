import type { Db } from '@sortiva/db'
import {
  isAccountFlagActive,
  isGlobalFlagActive,
  accountScope,
  readLifecycleState,
  systemScope,
} from '@sortiva/db'
import {
  ACCOUNT_INTENT_GAP_PAUSED_FLAG,
  ACCOUNT_OPTIMIZE_PAUSED_FLAG,
  ACCOUNT_PAUSED_FLAG,
  ACCOUNT_PUBLISHING_PAUSED_FLAG,
  ALL_WORK_PAUSED_FLAG,
  PUBLISHING_PAUSED_FLAG,
  billingGate,
  lifecycleGate,
  type LifecycleGate,
  type Logger,
} from '@sortiva/core'
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

/**
 * The other half of "may this run": the three things about the *account* rather
 * than about the product's brakes.
 *
 * Not paid up stops writing and never stops reading. Vacation mode stops
 * writing while the store keeps being read and Search Console keeps reporting,
 * so a merchant comes back to current data rather than a month-shaped hole.
 * A requested deletion stops everything.
 *
 * Separate from `mayAccountWorkRun` because the two answer different questions
 * and fail differently: a kill switch is an operator decision about the whole
 * product, and an unreadable one means stop. This is the merchant's own state,
 * and an account that has vanished between the dequeue and this read has
 * nothing to run.
 */
export async function accountLifecycleGate(db: Db, accountId: string): Promise<LifecycleGate> {
  const state = await readLifecycleState(db, accountScope(accountId))
  if (!state) {
    // No such account. Every gate closed, expressed the same way a deletion is,
    // because to a dispatcher they are the same situation.
    return lifecycleGate({
      billing: billingGate(null),
      vacationMode: false,
      deletionRequestedAt: new Date(0),
    })
  }
  return lifecycleGate({
    billing: billingGate(state.subscription),
    vacationMode: state.vacationMode,
    deletionRequestedAt: state.deletedAt,
  })
}

/**
 * Publishing has its own pair of switches, and they are deliberately not the
 * ones above.
 *
 * Stopping publishing is a much smaller thing than stopping generation: drafts
 * keep being written and reviewed, and nothing goes out to a merchant's store
 * until the switch comes down. That is why the publish error-rate trip raises
 * this rather than the master switch — a platform rejecting our posts is not a
 * reason to stop writing.
 *
 * `global.pause_all` closes this too. It stops everything; publishing is part of
 * everything.
 */
export async function mayAccountPublishingRun(
  db: Db,
  accountId: string,
  log: Logger = runtimeLogger(),
): Promise<WorkGateDecision> {
  try {
    const system = systemScope('kill switches are global by definition; this one has no account')
    for (const flag of [ALL_WORK_PAUSED_FLAG, PUBLISHING_PAUSED_FLAG]) {
      if (await isGlobalFlagActive(db, system, flag)) {
        return { allowed: false, reason: 'paused', flag }
      }
    }
    if (await isAccountFlagActive(db, accountScope(accountId), ACCOUNT_PUBLISHING_PAUSED_FLAG)) {
      return { allowed: false, reason: 'paused', flag: ACCOUNT_PUBLISHING_PAUSED_FLAG }
    }
    return ALLOWED
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    log.error('kill_switch_unreadable', { account_id: accountId, error_class: 'db_unavailable' })
    return { allowed: false, reason: 'unreadable', detail }
  }
}

/**
 * The two paid things a merchant sets off by clicking — an intent-gap analysis
 * and an OPTIMIZE generation — each have their own per-account daily ceiling
 * and their own switch. Crossing one stops that call type for that store for
 * the rest of the day and touches nothing else: the daily article still gets
 * written.
 */
const CALL_TYPE_FLAGS: Record<string, string> = {
  intent_gap: ACCOUNT_INTENT_GAP_PAUSED_FLAG,
  optimize_reco: ACCOUNT_OPTIMIZE_PAUSED_FLAG,
}

export async function mayCallTypeRun(
  db: Db,
  accountId: string,
  callType: 'intent_gap' | 'optimize_reco',
  log: Logger = runtimeLogger(),
): Promise<WorkGateDecision> {
  const general = await mayAccountWorkRun(db, accountId, log)
  if (!general.allowed) return general
  const flag = CALL_TYPE_FLAGS[callType]!
  try {
    if (await isAccountFlagActive(db, accountScope(accountId), flag)) {
      return { allowed: false, reason: 'paused', flag }
    }
    return ALLOWED
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    log.error('kill_switch_unreadable', { account_id: accountId, error_class: 'db_unavailable' })
    return { allowed: false, reason: 'unreadable', detail }
  }
}

/* ── The check at dequeue ─────────────────────────────────────────────────── */

/**
 * The jobs that keep running while everything else is paused, and why each one
 * has to.
 *
 * `global.pause_all` means "stop working for merchants". It does not mean
 * "stop being a company": a paused product still has to honour a deletion
 * request, still has to notice that spending is running away, still has to know
 * whether someone is paid up, and still has to be able to tell people what
 * happened. Gating those on the master switch would mean that the one action
 * an operator takes in an incident — pausing everything — also switches off the
 * brake that would catch the next runaway and the sweep that satisfies a legal
 * deadline.
 *
 * This list is deliberately short and deliberately explicit. Anything not on it
 * is gated, which is the safe direction: a lane that adds a job and forgets
 * this file gets a job that stops when the product is paused.
 */
export const UNGATED_TASKS: ReadonlyMap<string, string> = new Map([
  ['spend_cap_sweep', 'the brake itself; pausing the product must not switch off the thing that would catch the next runaway'],
  ['retention_sweep_daily', 'deletion and store-redaction deadlines are legal obligations with a clock, not merchant work'],
  ['account_close', 'a merchant who asked to leave leaves; nothing about an incident changes that'],
  ['email_send_drain', 'the mail queue is how anyone is told anything, including that we paused'],
])

export interface KillSwitchReader {
  (): Db
}

let killSwitchDb: KillSwitchReader | undefined
let warnedUninstalled = false

/**
 * The composition root hands the dequeue gate a way to reach the database.
 *
 * A factory rather than a handle, so installing it at process start opens no
 * connection pool — the same reason the task registrations take one.
 */
export function installKillSwitchReader(getDb: KillSwitchReader): void {
  killSwitchDb = getDb
}

/** True once the process can actually read the switches. `bootstrapWorker` refuses to start without it. */
export function killSwitchReaderInstalled(): boolean {
  return killSwitchDb !== undefined
}

/** Test-only: the reader is a module singleton. */
export function resetKillSwitchReader(): void {
  killSwitchDb = undefined
  warnedUninstalled = false
}

/**
 * Wraps one task handler in the check the spec puts at job dequeue.
 *
 * Every registered task goes through this — see `registerTask` — so a lane
 * cannot ship a job that forgets to consult the switches. Two consequences
 * worth stating plainly:
 *
 * - **The reading is never cached.** The switches are read from the database at
 *   the moment the job starts, so the worst case between an operator flipping a
 *   switch and work stopping is however long the job already in flight takes,
 *   not a cache lifetime.
 * - **A paused job is not a failed job.** It returns without doing anything and
 *   without throwing, so it is not retried, not dead-lettered and does not look
 *   like a fault. The queue will hand the work back when it is next asked for.
 */
export function guardedTask<T extends (payload: unknown, ...rest: never[]) => Promise<unknown>>(
  name: string,
  task: T,
  log: Logger = runtimeLogger(),
): T {
  const exemption = UNGATED_TASKS.get(name)
  if (exemption !== undefined) return task

  const wrapped = async (payload: unknown, ...rest: never[]): Promise<unknown> => {
    if (!killSwitchDb) {
      if (!warnedUninstalled) {
        warnedUninstalled = true
        log.error('kill_switch_gate_not_installed', {
          reason: 'no database reader was installed, so jobs are running unchecked',
        })
      }
      return task(payload, ...rest)
    }

    const db = killSwitchDb()
    const accountId = (payload as { accountId?: unknown } | undefined)?.accountId
    const decision =
      typeof accountId === 'string' && accountId !== ''
        ? await mayAccountWorkRun(db, accountId, log)
        : await mayGlobalWorkRun(db, log)

    if (!decision.allowed) {
      log.warn('job.paused', {
        task: name,
        ...(typeof accountId === 'string' ? { account_id: accountId } : {}),
        reason: decision.reason,
        ...(decision.reason === 'paused' ? { flag: decision.flag } : {}),
      })
      return undefined
    }
    return task(payload, ...rest)
  }

  return wrapped as unknown as T
}

/**
 * The half of the gate that applies to work with no account attached — a
 * global sweep, a scheduled pass over everybody. Only the master switch can
 * stop it, because the per-account switches have no account to be about.
 */
export async function mayGlobalWorkRun(
  db: Db,
  log: Logger = runtimeLogger(),
): Promise<WorkGateDecision> {
  try {
    const system = systemScope('kill switches are global by definition; this one has no account')
    if (await isGlobalFlagActive(db, system, ALL_WORK_PAUSED_FLAG)) {
      return { allowed: false, reason: 'paused', flag: ALL_WORK_PAUSED_FLAG }
    }
    return ALLOWED
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    log.error('kill_switch_unreadable', { error_class: 'db_unavailable' })
    return { allowed: false, reason: 'unreadable', detail }
  }
}

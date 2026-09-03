import { sql } from 'drizzle-orm'
import type pg from 'pg'
import { accountsWithLiveGscConnection, accountsWithTimezone, systemScope, type Db } from '@sortiva/db'
import { runtimeLogger } from '../runtime/logging'
import { registerTask } from '../runtime/tasks'
import { runIntentGapPassForAccount, type IntentGapPassDeps } from './intent-gap-pass'

/**
 * When the paid page comparison actually happens: a sweep that runs every hour
 * and asks, per store, whether it is that store's day — then one job per store
 * that does the buying.
 *
 * **Why a day of its own, before the scan's.** The comparison used to have
 * nowhere to run: `T6.1` built it and the only place named for it was inside
 * the weekly signal scan, which is otherwise free arithmetic over data already
 * on hand. Putting minutes of page fetches and a model call in there would have
 * made every other signal wait on them and fail with them. So the founder split
 * it: this pass buys, and the scan reads what it bought. The scan runs on each
 * store's local Monday, so this runs on the local Sunday before it — a
 * comparison is good for as long as the results page it was made against, which
 * is a week, so Sunday's answers are still there for Monday's scan and for the
 * six days after it.
 *
 * **Why hourly and not weekly.** A crontab can only name a fixed UTC moment,
 * and no fixed moment is Sunday everywhere at once — a store far enough west
 * would never match and would go permanently uncompared rather than merely
 * late. So the sweep runs 24 times a day and each run matches the stores whose
 * own clock has just turned Sunday. The runs that match nothing cost two
 * indexed reads, and the runs that match again queue nothing new: the job key
 * is the store and its own date.
 *
 * **Why a job per store rather than a loop.** A pass is up to ten pages, each
 * a results page, five page reads and a model call. One sweep doing all of them
 * would mean one slow store delaying every store behind it, and a crash
 * half-way losing the rest of the list.
 *
 * **Nothing schedules this yet.** `INTENT_GAP_SWEEP_TASK` is deliberately not
 * in `crontab.ts`: the recurring schedule is switched off by founder decision
 * until the last handlerless entries land, and turning paid work on is not this
 * card's to do. See DECISIONS 2026-09-04 R-INTENTGAP-JOB.
 */

export const INTENT_GAP_SWEEP_TASK = 'intent_gap_scan_weekly'
export const INTENT_GAP_ACCOUNT_TASK = 'intent_gap_scan_account'

/** The day of the week, on the store's own clock, that the pass runs — the day before the weekly scan reads it. */
const PASS_WEEKDAY = 'Sun'

export interface IntentGapAccountPayload {
  readonly accountId: string
  /** The store's own calendar date this pass is for. Part of the job key, so 24 sweeps queue one job. */
  readonly date: string
}

export interface IntentGapTaskDeps extends Omit<IntentGapPassDeps, 'db' | 'pool'> {
  /** Factories rather than handles, so registering at process start opens no connection. */
  readonly getDb: () => Db
  readonly getPool: () => pg.Pool
}

/**
 * Asks for one store's pass.
 *
 * The job key is the store and its own date, so every hour of that store's
 * Sunday queues **one** job. That is the cheap first line of defence; the real
 * one is the derived idempotency key inside the pass, which holds even when the
 * queue delivers the same job twice.
 */
export async function enqueueIntentGapPass(db: Db, payload: IntentGapAccountPayload): Promise<void> {
  const body = JSON.stringify(payload)
  const key = `${INTENT_GAP_ACCOUNT_TASK}:${payload.accountId}:${payload.date}`
  await db.execute(
    sql`select graphile_worker.add_job(${INTENT_GAP_ACCOUNT_TASK}, payload := ${body}::json, job_key := ${key}, job_key_mode := 'preserve_run_at')`,
  )
}

/** The store's own calendar date and weekday name. An unreadable zone falls back to UTC rather than skipping the store. */
function localDay(now: Date, timeZone: string): { readonly date: string; readonly weekday: string } {
  const read = (zone: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    }).formatToParts(now)
  let parts
  try {
    parts = read(timeZone)
  } catch {
    parts = read('UTC')
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return { date: `${get('year')}-${get('month')}-${get('day')}`, weekday: get('weekday') }
}

export async function sweepIntentGapPasses(
  deps: IntentGapTaskDeps,
): Promise<{ readonly considered: number; readonly queued: number }> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const db = deps.getDb()

  // Only stores whose Search Console is connected. The shortlist is a filter
  // over search positions, so a store without them has nothing to shortlist and
  // a pass for it would be a walk that buys nothing and finds nothing.
  const connected = new Set(
    await accountsWithLiveGscConnection(
      db,
      systemScope('the intent-gap pass looks across every account with search data for its own local Sunday'),
    ),
  )
  const clocks = await accountsWithTimezone(
    db,
    systemScope('the intent-gap pass needs each account\'s own clock to know whose Sunday it is'),
  )

  let considered = 0
  let queued = 0
  for (const { accountId, timezone } of clocks) {
    if (!connected.has(accountId)) continue
    considered += 1
    const day = localDay(now, timezone)
    if (day.weekday !== PASS_WEEKDAY) continue
    await enqueueIntentGapPass(db, { accountId, date: day.date })
    queued += 1
  }

  log.info('intent_gap_sweep_complete', { considered, queued })
  return { considered, queued }
}

let registered = false

export function registerIntentGapTasks(deps: IntentGapTaskDeps): void {
  if (registered) return
  registered = true

  registerTask(INTENT_GAP_SWEEP_TASK, async () => {
    await sweepIntentGapPasses(deps)
  })

  registerTask(INTENT_GAP_ACCOUNT_TASK, async (payload) => {
    const { accountId } = payload as IntentGapAccountPayload
    if (typeof accountId !== 'string' || accountId === '') {
      throw new Error('intent_gap_scan_account was queued without an accountId')
    }
    // The payload's date is deliberately not passed down: the pass reads the
    // store's own clock again, so a job that sat in the queue past midnight is
    // recorded against the day it actually ran on rather than the day it was
    // asked for.
    await runIntentGapPassForAccount({ ...deps, db: deps.getDb(), pool: deps.getPool() }, accountId)
  })
}

/** Test-only: the task registry is a module singleton, and so is this latch. */
export function resetIntentGapTaskRegistration(): void {
  registered = false
}

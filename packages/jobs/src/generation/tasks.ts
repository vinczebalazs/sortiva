import { sql } from 'drizzle-orm'
import type pg from 'pg'
import {
  generationHourFor,
  localClock,
  type Logger,
  type NotificationEmitter,
  type PosthogCapture,
} from '@sortiva/core'
import { accountClocks, systemScope, type Db } from '@sortiva/db'
import { rules } from '@sortiva/rules'
import { registerTask } from '../runtime/tasks'
import { runtimeLogger } from '../runtime/logging'
import { runDailyGenerationForAccount, type DailyGenerationDeps } from './daily-cycle'

/**
 * How the day's article actually gets written: a sweep that runs every hour and
 * asks, per store, whether it is that store's moment — then one job per store
 * that does the work.
 *
 * **Why hourly and not once.** A schedule can only say "03:00 UTC", and 03:00
 * UTC is a different time of day in every country. Main §9.1 anchors the cycle
 * to the store's own timezone and §9.4 requires it to finish before the store's
 * own publish hour, and a single fixed moment cannot be both for a German store
 * and an Australian one. So the sweep runs 24 times a day and each run matches
 * the handful of stores whose local clock has just reached their generation
 * hour. The 23 runs that do not match a given store cost two indexed reads.
 * This is the same shape the weekly signal scan and the monthly summary already
 * use.
 *
 * **Why a job per store rather than a loop.** Writing an article is minutes of
 * model calls. Running every store's inside one sweep would mean one slow store
 * delaying everyone behind it, and a crash halfway through losing the rest of
 * the list. One job each means one store's failure is one store's failure, and
 * the queue's own retry applies to it alone.
 */

export const GENERATION_CYCLE_SWEEP_TASK = 'generation_cycle_daily'
export const GENERATION_CYCLE_ACCOUNT_TASK = 'generation_cycle_account'

export interface GenerationCycleAccountPayload {
  readonly accountId: string
  /** The store's own calendar date this job is for. Part of the job key, so two sweeps in one local day queue one job. */
  readonly date: string
}

export interface GenerationTaskDeps extends Omit<DailyGenerationDeps, 'db' | 'pool'> {
  readonly getDb: () => Db
  /** Factories rather than handles, so registering at process start opens no connection. */
  readonly getPool: () => pg.Pool
  /**
   * Required here although the cycle itself will run without one: this is the
   * type the running product is built from, and a store with draft review
   * switched on and no bell wired is a store whose articles quietly stop
   * appearing. A missing emitter is a build failure rather than a silence
   * somebody notices weeks later.
   */
  readonly notifications: NotificationEmitter
  readonly capture?: Pick<PosthogCapture, 'capture'>
  readonly now?: () => Date
  readonly logger?: Logger
}

/**
 * Asks for one store's day.
 *
 * The job key is the store and its own date, so the hour that matched and any
 * hour that matched again queue **one** job rather than two. That is a cheap
 * first line of defence; the real one is the derived idempotency key inside the
 * run, which holds even when the queue delivers the same job twice.
 */
export async function enqueueGenerationCycle(
  db: Db,
  payload: GenerationCycleAccountPayload,
): Promise<void> {
  const body = JSON.stringify(payload)
  const key = `${GENERATION_CYCLE_ACCOUNT_TASK}:${payload.accountId}:${payload.date}`
  await db.execute(
    sql`select graphile_worker.add_job(${GENERATION_CYCLE_ACCOUNT_TASK}, payload := ${body}::json, job_key := ${key}, job_key_mode := 'preserve_run_at')`,
  )
}

export async function sweepGenerationCycles(
  deps: GenerationTaskDeps,
): Promise<{ readonly considered: number; readonly queued: number }> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const db = deps.getDb()
  const lead = rules().defaults.generation.cycle.lead_hours_before_publish_hour

  const clocks = await accountClocks(
    db,
    systemScope('the daily generation sweep looks across every live account for its own local hour'),
  )

  let queued = 0
  for (const clock of clocks) {
    const local = localClock(now, clock.timezone)
    if (local.hour !== generationHourFor(clock.publishHour, lead)) continue
    await enqueueGenerationCycle(db, { accountId: clock.accountId, date: local.date })
    queued += 1
  }

  log.info('generation_cycle_sweep_complete', { considered: clocks.length, queued })
  return { considered: clocks.length, queued }
}

let registered = false

export function registerGenerationTasks(deps: GenerationTaskDeps): void {
  if (registered) return
  registered = true

  registerTask(GENERATION_CYCLE_SWEEP_TASK, async () => {
    await sweepGenerationCycles(deps)
  })

  registerTask(GENERATION_CYCLE_ACCOUNT_TASK, async (payload) => {
    const { accountId } = payload as GenerationCycleAccountPayload
    if (typeof accountId !== 'string' || accountId === '') {
      throw new Error('generation_cycle_account was queued without an accountId')
    }
    // The payload's date is deliberately not passed down: the run reads the
    // store's own clock again. A job that sat in the queue past midnight
    // belongs to the day it actually runs on, not the day it was asked for —
    // the alternative is generating yesterday's topic today, which is exactly
    // the back-filled burst the calendar's gap rule forbids.
    await runDailyGenerationForAccount({ ...deps, db: deps.getDb(), pool: deps.getPool() }, accountId)
  })
}

/** Test-only: the task registry is a module singleton, and so is this latch. */
export function resetGenerationTaskRegistration(): void {
  registered = false
}

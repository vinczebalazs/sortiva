import { sql } from 'drizzle-orm'
import type pg from 'pg'
import { localClock, type Logger, type PosthogCapture } from '@sortiva/core'
import { accountClocks, systemScope, type Db } from '@sortiva/db'
import { registerTask } from '../runtime/tasks'
import { runtimeLogger } from '../runtime/logging'
import { runDriftPassForAccount, type DriftSweepDeps } from './sweep'

/**
 * How the check on published articles reaches every store.
 *
 * The same two-job shape the publish hour and the generation cycle use: a sweep
 * that names the stores due for a pass, and a job per store so one store's
 * failure is one store's failure and the queue's retry applies to it alone.
 *
 * Once a day rather than on every change the store makes. Two of the four things
 * this looks for are not events at all — a product being unbuyable *for a
 * fortnight*, and a range's attributes no longer being the ones an article
 * compares on — so no message from Shopify can announce them; only looking can
 * find them. A withdrawn product is announced, and a daily pass is what keeps
 * the product's own promise to act on one inside a day.
 */

export const DRIFT_SWEEP_TASK = 'drift_sweep_daily'
export const DRIFT_ACCOUNT_TASK = 'drift_pass_account'

export interface DriftPassPayload {
  readonly accountId: string
  /** The store's own date this pass belongs to. Part of the job key, so one day queues one pass. */
  readonly date: string
}

export interface DriftTaskDeps extends Omit<DriftSweepDeps, 'db' | 'pool'> {
  /** Factories rather than handles, so registering at process start opens no connection. */
  readonly getDb: () => Db
  readonly getPool: () => pg.Pool
  readonly capture?: Pick<PosthogCapture, 'capture'>
  readonly now?: () => Date
  readonly logger?: Logger
}

export async function enqueueDriftPass(db: Db, payload: DriftPassPayload): Promise<void> {
  const body = JSON.stringify(payload)
  const key = `${DRIFT_ACCOUNT_TASK}:${payload.accountId}:${payload.date}`
  await db.execute(
    sql`select graphile_worker.add_job(${DRIFT_ACCOUNT_TASK}, payload := ${body}::json, job_key := ${key}, job_key_mode := 'preserve_run_at')`,
  )
}

export async function sweepDrift(
  deps: DriftTaskDeps,
): Promise<{ readonly considered: number; readonly queued: number }> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const db = deps.getDb()

  const clocks = await accountClocks(
    db,
    systemScope('the drift pass looks across every live account for articles that have gone stale'),
  )

  for (const clock of clocks) {
    // Keyed on the store's own date rather than on ours, so a store an hour
    // either side of midnight UTC still gets exactly one pass per its own day.
    await enqueueDriftPass(db, {
      accountId: clock.accountId,
      date: localClock(now, clock.timezone).date,
    })
  }

  log.info('drift_sweep_complete', { considered: clocks.length, queued: clocks.length })
  return { considered: clocks.length, queued: clocks.length }
}

let registered = false

export function registerDriftTasks(deps: DriftTaskDeps): void {
  if (registered) return
  registered = true

  registerTask(DRIFT_SWEEP_TASK, async () => {
    await sweepDrift(deps)
  })

  registerTask(DRIFT_ACCOUNT_TASK, async (payload) => {
    const { accountId } = payload as DriftPassPayload
    if (typeof accountId !== 'string' || accountId === '') {
      throw new Error('drift_pass_account was queued without an accountId')
    }
    await runDriftPassForAccount(
      { ...deps, db: deps.getDb(), pool: deps.getPool() },
      { accountId },
    )
  })
}

/** Test-only: the task registry is a module singleton, and so is this latch. */
export function resetDriftTaskRegistration(): void {
  registered = false
}

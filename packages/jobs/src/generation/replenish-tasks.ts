import { sql } from 'drizzle-orm'
import type pg from 'pg'
import { localClock, type Logger, type PosthogCapture } from '@sortiva/core'
import { accountsReadyForPlanning, readAccountSettings, accountScope, systemScope, type Db } from '@sortiva/db'
import { registerTask } from '../runtime/tasks'
import { runtimeLogger } from '../runtime/logging'
import { replenishCalendarForAccount, type ReplenishDeps } from './replenish'

/**
 * How the calendar gets topped up: a monthly sweep that asks every planning
 * account whether its runway has run short, and one job per store that does
 * the filling.
 *
 * **Why a job per store rather than a loop.** Same reason as the daily
 * generation cycle: one store's failure should be one store's failure, and the
 * queue's retry should apply to it alone rather than restarting a pass over
 * every account.
 *
 * The sweep itself decides nothing about whether a top-up is *due* — that is a
 * read of the store's own calendar, made inside the per-account lock by the job
 * — so a sweep that runs twice, or a job delivered twice, costs a read and
 * changes nothing.
 */

export const REPLENISHMENT_SWEEP_TASK = 'replenishment_monthly'
export const REPLENISHMENT_ACCOUNT_TASK = 'replenishment_account'

export interface ReplenishmentAccountPayload {
  readonly accountId: string
  /** The store's own calendar date this job was queued for — part of the job key, so one local day queues one job. */
  readonly date: string
}

export interface ReplenishmentTaskDeps extends Omit<ReplenishDeps, 'db' | 'pool'> {
  readonly getDb: () => Db
  /** Factories rather than handles, so registering at process start opens no connection. */
  readonly getPool: () => pg.Pool
  readonly capture?: Pick<PosthogCapture, 'capture'>
  readonly now?: () => Date
  readonly logger?: Logger
}

export async function enqueueReplenishment(db: Db, payload: ReplenishmentAccountPayload): Promise<void> {
  const body = JSON.stringify(payload)
  const key = `${REPLENISHMENT_ACCOUNT_TASK}:${payload.accountId}:${payload.date}`
  await db.execute(
    sql`select graphile_worker.add_job(${REPLENISHMENT_ACCOUNT_TASK}, payload := ${body}::json, job_key := ${key}, job_key_mode := 'preserve_run_at')`,
  )
}

export async function sweepReplenishment(
  deps: ReplenishmentTaskDeps,
): Promise<{ readonly considered: number; readonly queued: number }> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const db = deps.getDb()

  const accountIds = await accountsReadyForPlanning(
    db,
    systemScope('the monthly replenishment sweep looks across every planning account for a calendar running short'),
  )

  for (const accountId of accountIds) {
    const settings = await readAccountSettings(db, accountScope(accountId))
    await enqueueReplenishment(db, { accountId, date: localClock(now, settings.timezone).date })
  }

  log.info('replenishment_sweep_complete', { considered: accountIds.length, queued: accountIds.length })
  return { considered: accountIds.length, queued: accountIds.length }
}

let registered = false

export function registerReplenishmentTasks(deps: ReplenishmentTaskDeps): void {
  if (registered) return
  registered = true

  registerTask(REPLENISHMENT_SWEEP_TASK, async () => {
    await sweepReplenishment(deps)
  })

  registerTask(REPLENISHMENT_ACCOUNT_TASK, async (payload) => {
    const { accountId } = payload as ReplenishmentAccountPayload
    if (typeof accountId !== 'string' || accountId === '') {
      throw new Error('replenishment_account was queued without an accountId')
    }
    await replenishCalendarForAccount({ ...deps, db: deps.getDb(), pool: deps.getPool() }, accountId)
  })
}

/** Test-only: the task registry is a module singleton, and so is this latch. */
export function resetReplenishmentTaskRegistration(): void {
  registered = false
}

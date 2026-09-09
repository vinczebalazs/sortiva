import { sql } from 'drizzle-orm'
import type pg from 'pg'
import { isPublishHour, localClock, type Logger, type PosthogCapture } from '@sortiva/core'
import { accountClocks, systemScope, type Db } from '@sortiva/db'
import { registerTask } from '../runtime/tasks'
import { runtimeLogger } from '../runtime/logging'
import { runExportDeliveryForAccount, type DeliveryDeps } from './deliver'
import { sweepPublishRecovery } from './recovery'
import type { AutoPublishDeps } from './auto-publish'

/**
 * How a finished article reaches the merchant at the hour they chose.
 *
 * The same two-job shape the daily generation cycle uses, and for the same
 * reason: a schedule can only say "09:00 UTC", and 09:00 UTC is the middle of
 * the night for half the world. So this sweep runs every hour and matches only
 * the stores whose own clock has just struck their publish hour; the 23 runs
 * that match a given store cost two indexed reads.
 *
 * A job per store rather than a loop, so one store's failure is one store's
 * failure and the queue's retry applies to it alone.
 */

export const PUBLISH_DELIVERY_SWEEP_TASK = 'publish_delivery_sweep'
export const PUBLISH_DELIVERY_ACCOUNT_TASK = 'publish_delivery_account'
/**
 * The five-minute sweep that settles publications a crash left unanswered.
 *
 * Its own schedule rather than part of the hourly delivery sweep, because the
 * window it closes is minutes wide: between a post landing on a merchant's shop
 * and our recording that it did, the app believes the article never went out.
 * Waiting up to an hour to notice would make every crash a visible outage.
 */
export const PUBLISH_INTENT_RECOVERY_SWEEP_TASK = 'publish_intent_recovery_sweep'

export interface PublishDeliveryPayload {
  readonly accountId: string
  /** The store's own date this delivery belongs to. Part of the job key, so one hour queues one job. */
  readonly date: string
}

export interface PublishTaskDeps extends Omit<DeliveryDeps, 'db' | 'pool'> {
  readonly getDb: () => Db
  /** Factories rather than handles, so registering at process start opens no connection. */
  readonly getPool: () => pg.Pool
  readonly capture?: Pick<PosthogCapture, 'capture'>
  readonly now?: () => Date
  readonly logger?: Logger
}

export async function enqueuePublishDelivery(db: Db, payload: PublishDeliveryPayload): Promise<void> {
  const body = JSON.stringify(payload)
  const key = `${PUBLISH_DELIVERY_ACCOUNT_TASK}:${payload.accountId}:${payload.date}`
  await db.execute(
    sql`select graphile_worker.add_job(${PUBLISH_DELIVERY_ACCOUNT_TASK}, payload := ${body}::json, job_key := ${key}, job_key_mode := 'preserve_run_at')`,
  )
}

export async function sweepPublishDeliveries(
  deps: PublishTaskDeps,
): Promise<{ readonly considered: number; readonly queued: number }> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const db = deps.getDb()

  const clocks = await accountClocks(
    db,
    systemScope('the publish sweep looks across every live account for its own publish hour'),
  )

  let queued = 0
  for (const clock of clocks) {
    const local = localClock(now, clock.timezone)
    if (!isPublishHour(local.hour, clock.publishHour)) continue
    await enqueuePublishDelivery(db, { accountId: clock.accountId, date: local.date })
    queued += 1
  }

  log.info('publish_delivery_sweep_complete', { considered: clocks.length, queued })
  return { considered: clocks.length, queued }
}

let registered = false

export function registerPublishTasks(deps: PublishTaskDeps): void {
  if (registered) return
  registered = true

  registerTask(PUBLISH_DELIVERY_SWEEP_TASK, async () => {
    await sweepPublishDeliveries(deps)
  }, 'fans_out')

  registerTask(PUBLISH_INTENT_RECOVERY_SWEEP_TASK, async () => {
    if (!(deps.shopify && deps.cipher)) {
      // A process with no way to write to a shop has nothing to recover. Said
      // out loud rather than passed over: a silent no-op here would look
      // identical to a sweep that ran and found nothing.
      ;(deps.logger ?? runtimeLogger()).warn('publish_recovery_unconfigured', {})
      return
    }
    await sweepPublishRecovery({
      ...(deps as Omit<AutoPublishDeps, 'db' | 'pool' | 'shopify' | 'cipher'>),
      db: deps.getDb(),
      pool: deps.getPool(),
      shopify: deps.shopify,
      cipher: deps.cipher,
    })
  }, 'fans_out')

  registerTask(PUBLISH_DELIVERY_ACCOUNT_TASK, async (payload) => {
    const { accountId, date } = payload as PublishDeliveryPayload
    if (typeof accountId !== 'string' || accountId === '') {
      throw new Error('publish_delivery_account was queued without an accountId')
    }
    if (typeof date !== 'string' || date === '') {
      throw new Error('publish_delivery_account was queued without a date')
    }
    // Unlike the generation cycle, the date *is* passed down. The two are
    // asking different questions: generation asks which day's topic to write,
    // which must be re-derived if the job waited; delivery asks which hour's
    // turn this is, and a job that waited is still that hour's turn. Carrying
    // the date is what makes the derived key stable across a retry.
    await runExportDeliveryForAccount(
      { ...deps, db: deps.getDb(), pool: deps.getPool() },
      { accountId, date },
    )
  }, 'per_account')
}

/** Test-only: the task registry is a module singleton, and so is this latch. */
export function resetPublishTaskRegistration(): void {
  registered = false
}

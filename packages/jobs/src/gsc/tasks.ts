import type pg from 'pg'
import type { GscProvider, Logger } from '@sortiva/core'
import { accountsWithLiveGscConnection, systemScope, type Db } from '@sortiva/db'
import { dailySyncRange } from '@sortiva/core'
import { rules } from '@sortiva/rules'
import { tryWithAccountLock } from '../runtime/lock'
import { runtimeLogger } from '../runtime/logging'
import { registerTask } from '../runtime/tasks'
import { runGscBackfillChunk } from './backfill'
import { GSC_BACKFILL_TASK, type GscBackfillPayload } from './queue'
import { syncSearchConsoleRange, type GscSyncDeps, type TokenCodec } from './sync'

/**
 * The two background jobs that keep a store's search data current: the nightly
 * pull, and the one-time import of history that runs when a merchant first
 * connects.
 *
 * Neither can start the day a merchant connects and then quietly stop: both
 * treat a dead Google grant as "record it and move on", never as a failure that
 * would spread to the rest of that store's work.
 */

export const GSC_SYNC_DAILY_TASK = 'gsc_sync_daily'

export interface GscTaskDeps {
  readonly getDb: () => Db
  /**
   * The shared connection pool. Required rather than looked up here: naming
   * concrete infrastructure is the composition root's job, and a background job
   * cannot be handed its database by a request.
   */
  readonly getPool: () => pg.Pool
  readonly provider: GscProvider
  readonly codec: TokenCodec
  readonly now?: () => Date
  readonly logger?: Logger
}

/**
 * Pulls the most recent days for every store with a live connection.
 *
 * One account being busy is not a reason to fail the sweep: the lock is tried
 * rather than waited on, and an account that was busy is picked up by tomorrow's
 * run, or by the import that was holding it. Skipping a night of a seven-day
 * window loses nothing, because the next run re-asks for the same days.
 */
export async function runDailyGscSync(deps: GscTaskDeps): Promise<{
  accounts: number
  synced: number
  skipped: number
}> {
  const db = deps.getDb()
  const pool = deps.getPool()
  const log = deps.logger ?? runtimeLogger()
  const now = deps.now ?? (() => new Date())
  const config = rules().defaults.search_console

  const accountIds = await accountsWithLiveGscConnection(
    db,
    systemScope('the nightly Search Console pull chooses which stores to work for'),
  )

  const range = dailySyncRange({
    today: now(),
    lookbackDays: config.daily_sync_lookback_days,
    dataLagDays: config.data_lag_days,
  })

  const syncDeps: GscSyncDeps = {
    db,
    provider: deps.provider,
    codec: deps.codec,
    ...(deps.now ? { now: deps.now } : {}),
    logger: log,
  }

  let synced = 0
  let skipped = 0
  for (const accountId of accountIds) {
    const outcome = await tryWithAccountLock(pool, accountId, async () =>
      syncSearchConsoleRange(syncDeps, accountId, range),
    )
    if (outcome === undefined) {
      skipped += 1
      continue
    }
    if (outcome.status === 'synced') synced += 1
    else skipped += 1
  }

  log.info('gsc_sync_daily_complete', {
    accounts: accountIds.length,
    synced,
    skipped,
    start_date: range.startDate,
    end_date: range.endDate,
  })
  return { accounts: accountIds.length, synced, skipped }
}

let registered = false

/**
 * Joins both jobs to the worker's task list. Registering a handler does not by
 * itself switch its schedule on: the worker refuses to enable cron until every
 * scheduled job has a handler, and most still do not.
 *
 * Takes factories rather than a database handle so registering at process start
 * opens no connection — a local session with the worker switched off should not
 * need a database to boot.
 */
export function registerGscTasks(deps: GscTaskDeps): void {
  if (registered) return
  registered = true

  registerTask(GSC_SYNC_DAILY_TASK, async () => {
    await runDailyGscSync(deps)
  })

  registerTask(GSC_BACKFILL_TASK, async (rawPayload, helpers) => {
    const payload = rawPayload as GscBackfillPayload
    const pool = deps.getPool()
    const log = deps.logger ?? runtimeLogger()

    const step = await tryWithAccountLock(pool, payload.accountId, async () =>
      runGscBackfillChunk(
        {
          db: deps.getDb(),
          provider: deps.provider,
          codec: deps.codec,
          ...(deps.now ? { now: deps.now } : {}),
          logger: log,
        },
        payload,
      ),
    )

    // The account is busy with something else. Hand the same work back to the
    // queue rather than waiting on the lock, so a worker slot is not parked for
    // minutes on a job that has all the time in the world.
    if (step === undefined) {
      await helpers.addJob(GSC_BACKFILL_TASK, payload, { runAt: new Date(Date.now() + 60_000) })
      return
    }

    if (step.status === 'chunk_done') {
      await helpers.addJob(GSC_BACKFILL_TASK, step.next)
    }
  })
}

/** Test-only: the task registry is a module singleton, and so is this latch. */
export function resetGscTaskRegistration(): void {
  registered = false
}

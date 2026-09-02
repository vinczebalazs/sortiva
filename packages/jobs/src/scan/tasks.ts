import type pg from 'pg'
import type { Logger } from '@sortiva/core'
import { accountsWithLiveGscConnection, systemScope, type Db } from '@sortiva/db'
import { tryWithAccountLock } from '../runtime/lock'
import { runtimeLogger } from '../runtime/logging'
import { registerTask } from '../runtime/tasks'
import { refitCtrCurveForAccount } from './ctr-curve'

/**
 * The weekly refit of every store's own click curve.
 *
 * Weekly rather than nightly because click behaviour moves over months, and a
 * curve that jumped every night would have the same page flagged and unflagged
 * on alternate days.
 */

export const CTR_CURVE_REFIT_TASK = 'ctr_curve_refit_weekly'

export interface ScanTaskDeps {
  readonly getDb: () => Db
  /** The shared connection pool. Naming concrete infrastructure is the composition root's job. */
  readonly getPool: () => pg.Pool
  readonly now?: () => Date
  readonly logger?: Logger
}

export async function runCtrCurveRefit(deps: ScanTaskDeps): Promise<{
  accounts: number
  fitted: number
  skipped: number
}> {
  const db = deps.getDb()
  const pool = deps.getPool()
  const log = deps.logger ?? runtimeLogger()

  const accountIds = await accountsWithLiveGscConnection(
    db,
    systemScope('the weekly click-curve refit chooses which stores to work for'),
  )

  let fitted = 0
  let skipped = 0
  for (const accountId of accountIds) {
    // Tried rather than waited on: a store busy with its own work this minute
    // has a curve that is a week old, and a week and a minute is the same
    // answer. Next week's run picks it up.
    const outcome = await tryWithAccountLock(pool, accountId, async () =>
      refitCtrCurveForAccount(
        {
          db,
          ...(deps.now ? { now: deps.now } : {}),
          logger: log,
        },
        accountId,
      ),
    )
    if (outcome?.status === 'fitted') fitted += 1
    else skipped += 1
  }

  log.info('ctr_curve_refit_complete', { accounts: accountIds.length, fitted, skipped })
  return { accounts: accountIds.length, fitted, skipped }
}

let registered = false

/**
 * Takes factories rather than a database handle so registering at process start
 * opens no connection — a local session with the worker switched off should not
 * need a database to boot.
 */
export function registerScanTasks(deps: ScanTaskDeps): void {
  if (registered) return
  registered = true

  registerTask(CTR_CURVE_REFIT_TASK, async () => {
    await runCtrCurveRefit(deps)
  })
}

/** Test-only: the task registry is a module singleton, and so is this latch. */
export function resetScanTaskRegistration(): void {
  registered = false
}

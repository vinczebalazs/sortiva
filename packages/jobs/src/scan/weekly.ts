import {
  accountAttribution,
  isScanWeekday,
  scanLocalDay,
  weeklyScanRunId,
  type NotificationEmitter,
} from '@sortiva/core'
import { accountsWithTimezone, systemScope } from '@sortiva/db'
import { runtimeLogger } from '../runtime/logging'
import { runSignalScan, type RunSignalScanDeps } from './run'

/**
 * "Every Monday, persona-country clock" (main §7.5's cadence table) — the
 * same shape every local-hour sweep in this codebase already uses (the
 * monthly summary, `packages/jobs/src/notify/monthly-summary.ts`): a
 * crontab cannot express "Monday in each account's own zone", so this runs
 * hourly and asks, per account, whether it is currently Monday there. A
 * store nine hours off Sortiva's own clock does not lose its Monday.
 *
 * Re-runs are free of consequence: `run_id` is `weekly-<accountId>-<local
 * Monday date>`, so every hourly pass after the one that matched finds the
 * run already finished (`runSignalScan`'s own idempotency) and does
 * nothing.
 *
 * The local day and the run id are both worked out by `packages/core`
 * (`signals/next-scan.ts`) rather than here, because the Opportunities screen
 * tells the merchant when their next scan falls and has to reach that answer
 * by asking the same question this sweep asks. Two copies of "is it Monday
 * there?" would let the promise and the work drift apart without either side
 * failing.
 */

export interface WeeklyScanDeps extends RunSignalScanDeps {
  readonly notifications: NotificationEmitter
}

export async function sweepWeeklyScans(
  deps: WeeklyScanDeps,
): Promise<{ readonly considered: number; readonly scanned: number }> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const accounts = await accountsWithTimezone(
    deps.db,
    systemScope('the weekly signal scan looks across every live account for a local Monday'),
  )

  let scanned = 0
  for (const { accountId, timezone } of accounts) {
    const day = scanLocalDay(now, timezone)
    if (!isScanWeekday(day)) continue

    const outcome = await runSignalScan(deps, accountId, 'weekly', weeklyScanRunId(accountId, day.date))
    if (outcome.status !== 'completed') continue
    scanned += 1

    if (outcome.opportunitiesCreated > 0) {
      await deps.notifications.emit(
        'new_opportunities_found',
        { run_id: outcome.runId },
        outcome.runId,
        accountAttribution(accountId),
      )
    }
  }

  log.info('weekly_scan_sweep_complete', { considered: accounts.length, scanned })
  return { considered: accounts.length, scanned }
}

export { weeklyScanRunId as weeklyRunId }

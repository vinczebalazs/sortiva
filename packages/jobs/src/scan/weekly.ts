import { type NotificationEmitter, accountAttribution } from '@sortiva/core'
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
 */

export interface WeeklyScanDeps extends RunSignalScanDeps {
  readonly notifications: NotificationEmitter
}

interface LocalDay {
  readonly date: string
  readonly weekday: string
}

/** The account's own calendar date and weekday name, read the same way `localClock` does for the monthly summary — an unreadable zone falls back to UTC rather than skipping the store. */
function localDay(now: Date, timeZone: string): LocalDay {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(now)
  let parts
  try {
    parts = format(timeZone)
  } catch {
    parts = format('UTC')
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return { date: `${get('year')}-${get('month')}-${get('day')}`, weekday: get('weekday') }
}

function weeklyRunId(accountId: string, localMondayDate: string): string {
  return `weekly-${accountId}-${localMondayDate}`
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
    const day = localDay(now, timezone)
    if (day.weekday !== 'Mon') continue

    const outcome = await runSignalScan(deps, accountId, 'weekly', weeklyRunId(accountId, day.date))
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

export { weeklyRunId }

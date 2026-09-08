import {
  accountAttribution,
  isScanWeekday,
  scanLocalDay,
  weeklyScanAllowedFor,
  weeklyScanRunId,
  type NotificationEmitter,
  type StopReason,
} from '@sortiva/core'
import { accountsWithTimezone, systemScope } from '@sortiva/db'
import { accountLifecycleGate } from '../runtime/gate'
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
 * The local day, the run id, and whether the store is scanned at all are
 * worked out by `packages/core` (`signals/next-scan.ts`) rather than here,
 * because the Opportunities screen tells the merchant when their next scan
 * falls and has to reach that answer by asking the same questions this sweep
 * asks. Two copies of "is it Monday there?", or of "is this store being
 * scanned?", would let the promise and the work drift apart without either
 * side failing.
 */

export interface WeeklyScanDeps extends RunSignalScanDeps {
  readonly notifications: NotificationEmitter
}

export interface WeeklyScanSweepOutcome {
  readonly considered: number
  readonly scanned: number
  /** Stores whose local Monday it is but whose account state stops the scan. */
  readonly skipped: number
  /** How many of those each reason accounts for. A store stopped for two reasons is counted under both. */
  readonly skippedByReason: Readonly<Record<StopReason, number>>
}

export async function sweepWeeklyScans(deps: WeeklyScanDeps): Promise<WeeklyScanSweepOutcome> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const accounts = await accountsWithTimezone(
    deps.db,
    systemScope('the weekly signal scan looks across every live account for a local Monday'),
  )

  let scanned = 0
  let skipped = 0
  const skippedByReason: Record<StopReason, number> = {
    deletion_requested: 0,
    billing: 0,
    vacation: 0,
  }

  for (const { accountId, timezone } of accounts) {
    const day = scanLocalDay(now, timezone)
    if (!isScanWeekday(day)) continue

    // Asked before the scan rather than inside it, because the whole point is
    // to spend nothing: `runSignalScan` buys results pages from the search-data
    // vendor, and a store nobody is paying for should not reach that call at
    // all. Only stores whose Monday it is are asked, so this costs one row read
    // per store per week rather than per store per hour.
    const lifecycle = await accountLifecycleGate(deps.db, accountId)
    if (!weeklyScanAllowedFor(lifecycle)) {
      skipped += 1
      for (const reason of lifecycle.stoppedBy) skippedByReason[reason] += 1
      // A store that is not being scanned must never be silently not scanned.
      // Ids and reasons only — nothing here says anything about the store's
      // products, queries or content.
      log.info('weekly_scan.skipped_for_account_state', {
        account_id: accountId,
        local_day: day.date,
        reasons: lifecycle.stoppedBy,
      })
      continue
    }

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

  log.info('weekly_scan_sweep_complete', {
    considered: accounts.length,
    scanned,
    skipped,
    skipped_by_reason: skippedByReason,
  })
  return { considered: accounts.length, scanned, skipped, skippedByReason }
}

export { weeklyScanRunId as weeklyRunId }

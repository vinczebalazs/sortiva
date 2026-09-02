import { accountAttribution, type Logger, type NotificationEmitter } from '@sortiva/core'
import { accountsWithTimezone, systemScope, type Db } from '@sortiva/db'
import { runtimeLogger } from '../runtime/logging'
import { registerTask } from '../runtime/tasks'

/**
 * The month in review, sent on the first of the month at 08:00 **in the store's
 * own morning** — not ours.
 *
 * A crontab cannot express "08:00 in each account's zone", and pretending
 * otherwise is how a German store gets a summary at nine in the evening. So the
 * sweep runs every hour and each run asks, per account, whether it is locally
 * the first of the month at eight. Running it 24 times a day is free of
 * consequence because both the bell entry and the email key on the month the
 * summary covers: every run after the one that matched inserts nothing.
 */

export const MONTHLY_SUMMARY_TASK = 'monthly_summary'

/** The local hour a summary lands in. Early enough to be the first thing read, late enough not to wake anybody. */
const SEND_AT_LOCAL_HOUR = 8

export interface MonthlySummaryDeps {
  readonly getDb: () => Db
  readonly notifications: NotificationEmitter
  readonly logger?: Logger
  readonly now?: () => Date
}

export interface LocalClock {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
}

/**
 * What time it is where the merchant is. An unknown or malformed zone falls
 * back to UTC rather than throwing: a store whose zone we failed to record
 * should still get its summary, an hour or two out.
 */
export function localClock(now: Date, timeZone: string): LocalClock {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now)

  let parts
  try {
    parts = format(timeZone)
  } catch {
    parts = format('UTC')
  }
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0')
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour') }
}

/** The month a summary sent on this local morning covers: the one that just ended. */
export function periodCovered(clock: LocalClock): string {
  const month = clock.month === 1 ? 12 : clock.month - 1
  const year = clock.month === 1 ? clock.year - 1 : clock.year
  return `${year}-${String(month).padStart(2, '0')}`
}

export function isSendMoment(clock: LocalClock): boolean {
  return clock.day === 1 && clock.hour === SEND_AT_LOCAL_HOUR
}

export interface MonthlySummaryResult {
  readonly considered: number
  readonly notified: number
}

export async function sweepMonthlySummaries(
  deps: MonthlySummaryDeps,
): Promise<MonthlySummaryResult> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()

  const accounts = await accountsWithTimezone(
    deps.getDb(),
    systemScope('the monthly summary sweep looks across every live account for a local 08:00'),
  )

  let notified = 0
  let considered = 0
  for (const account of accounts) {
    const clock = localClock(now, account.timezone)
    if (!isSendMoment(clock)) continue
    considered += 1

    // The bell entry, and — through the emitter's fan-out — the email. Keyed on
    // the month, so a second hour that somehow matched sends nothing.
    const emitted = await deps.notifications.emit(
      'monthly_summary_ready',
      { period: periodCovered(clock) },
      periodCovered(clock),
      accountAttribution(account.accountId),
    )
    if (emitted.created) notified += 1
  }

  log.info('monthly_summary_sweep.completed', { considered, notified })
  return { considered, notified }
}

let registered = false

export function registerMonthlySummaryTask(deps: MonthlySummaryDeps): void {
  if (registered) return
  registered = true
  registerTask(MONTHLY_SUMMARY_TASK, async () => {
    await sweepMonthlySummaries(deps)
  })
}

/** Test-only: the task registry is a module singleton, and so is this latch. */
export function resetMonthlySummaryRegistration(): void {
  registered = false
}

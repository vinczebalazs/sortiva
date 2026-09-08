/**
 * When this store's weekly scan next falls — worked out from the rule the
 * sweep itself obeys, not from a cadence.
 *
 * The sweep that runs the weekly scan wakes on every hour and asks, per
 * account, "is it Monday where this merchant is?". So the moment a given
 * store is next scanned is the first of those wake-ups at which its own
 * calendar says Monday — which is a different instant for a Berlin store and
 * an Auckland one, and moves when either changes timezone. Adding seven days
 * to the last scan would name a weekday we do not control and would be wrong
 * for any store whose scan was skipped, delayed or re-queued; walking the
 * sweep's own wake-ups forward cannot be wrong in that way, because it is the
 * same question the sweep will ask.
 *
 * `sweepWeeklyScans` (`packages/jobs/src/scan/weekly.ts`) reads its local day,
 * derives its run id, and decides whether the store is scanned at all from
 * this file, so the prediction and the thing predicted cannot drift apart.
 */

import type { LifecycleGate } from '../lifecycle/gate'

/** The weekday the scan runs on, in the store's own week. */
const SCAN_WEEKDAY = 'Mon'

/**
 * How often the sweep wakes up. It is on the hour (`signal_scan_weekly` in
 * `packages/jobs/src/runtime/crontab.ts`), so no prediction can be finer than
 * this, and a store whose local midnight falls at :30 is scanned at the next
 * hour rather than at midnight. If that schedule is ever made coarser, this
 * answer becomes early by the difference rather than wrong about the day.
 */
const SWEEP_WAKES_EVERY_MS = 60 * 60 * 1000

/** How far ahead to look before giving up. A week plus a day's slack; a zone that never reaches Monday does not exist, so exhausting this means something is wrong and the honest answer is "we cannot say". */
const SEARCH_HORIZON_MS = 8 * 24 * 60 * 60 * 1000

export interface ScanLocalDay {
  /** `YYYY-MM-DD` where the merchant is. */
  readonly date: string
  /** Three-letter English weekday where the merchant is, e.g. `Mon`. */
  readonly weekday: string
}

/**
 * The account's own calendar date and weekday name. A zone we cannot parse
 * falls back to UTC rather than dropping the store: a scan an hour off is a
 * scheduling annoyance, a store that is never scanned is a broken product.
 */
export function scanLocalDay(now: Date, timeZone: string): ScanLocalDay {
  const read = (zone: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    }).formatToParts(now)

  let parts
  try {
    parts = read(timeZone)
  } catch {
    parts = read('UTC')
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return { date: `${get('year')}-${get('month')}-${get('day')}`, weekday: get('weekday') }
}

/**
 * The id one weekly pass is recorded under. Derived from the store's own
 * Monday rather than from the clock, so every wake-up after the one that
 * matched finds the pass already finished and does nothing — and so a caller
 * can ask "has this store's Monday already been done?" without guessing.
 */
export function weeklyScanRunId(accountId: string, localMondayDate: string): string {
  return `weekly-${accountId}-${localMondayDate}`
}

export function isScanWeekday(day: ScanLocalDay): boolean {
  return day.weekday === SCAN_WEEKDAY
}

/**
 * Whether the weekly scan runs for this store at all, judged on the state of
 * the account rather than on the calendar.
 *
 * A scan buys results pages from the search-data vendor, per store, every
 * week. Running one for a store nobody is paying for is a bill for nothing, so
 * three states stop it: the subscription is not active, the merchant has
 * switched vacation mode on, or deletion has been asked for. A store in any of
 * them comes back to opportunity cards up to a week old and waits for its next
 * Monday — the accepted cost of not spending on a store that is not trading
 * with us.
 *
 * **This takes nothing away from what the merchant can already see.** Cards
 * already on their board stay exactly as they are: nothing here deletes or
 * hides a row, and the only pass that retires a card is the scan itself, which
 * is not running. What stops is new analysis, which is the same thing billing
 * has always stopped.
 *
 * Read off `generationAllowed` rather than off the three flags separately, so
 * that the sweep and the next-scan date the Opportunities screen prints can
 * never disagree about whether a scan is coming. The name is not a perfect
 * fit — a signal scan writes no articles — but the set of accounts it covers
 * is exactly the three states above, and a second predicate over the same
 * three flags is how the two sides drift apart.
 */
export function weeklyScanAllowedFor(gate: Pick<LifecycleGate, 'generationAllowed'>): boolean {
  return gate.generationAllowed
}

export interface NextWeeklyScanInput {
  readonly now: Date
  /** IANA zone from `account_settings.timezone`. */
  readonly timeZone: string
  /**
   * Whether a scan is going to run for this account at all. False for a store
   * whose engine is stopped — a kill switch, a lapsed subscription, vacation
   * mode, a requested deletion — and false when we could not find out.
   */
  readonly scanRuns: boolean
  /**
   * Whether the store's *current* local date already has a finished weekly
   * pass against it. Only ever true on a Monday, because that is the only day
   * a pass is recorded for; it moves the answer on to next week instead of
   * promising a scan that has already happened.
   */
  readonly currentLocalDayAlreadyScanned: boolean
}

/**
 * `null` means we cannot say, and that is a real answer rather than a
 * fallback: no scan is coming for a stopped store, and naming a date for one
 * would be a promise the product would not keep.
 */
export function nextWeeklyScanAt(input: NextWeeklyScanInput): Date | null {
  if (!input.scanRuns) return null

  const today = scanLocalDay(input.now, input.timeZone)
  const startMs =
    Math.ceil(input.now.getTime() / SWEEP_WAKES_EVERY_MS) * SWEEP_WAKES_EVERY_MS
  const endMs = startMs + SEARCH_HORIZON_MS

  for (let ms = startMs; ms <= endMs; ms += SWEEP_WAKES_EVERY_MS) {
    const at = new Date(ms)
    const day = scanLocalDay(at, input.timeZone)
    if (!isScanWeekday(day)) continue
    if (input.currentLocalDayAlreadyScanned && day.date === today.date) continue
    return at
  }
  return null
}

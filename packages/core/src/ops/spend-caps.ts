/**
 * The automatic brakes on money.
 *
 * Two outside companies bill us per call — Anthropic for the model, DataForSEO
 * for search data — and every paid call already records what it cost into our
 * own `spend_events` table. This file is the arithmetic that decides, from
 * those rows, whether spending has run away; it pauses the product rather than
 * let us find out from the invoice.
 *
 * Deliberately pure: no database, no clock of its own, no configuration
 * lookup. It is handed the totals and the ceilings and answers yes or no, so
 * every branch can be tested without a Postgres or a fake vendor. The job in
 * `packages/jobs` supplies the numbers; the ceilings come from
 * `packages/rules`, which is the only place a threshold may live.
 *
 * Enforcement is ours end to end — our code, our database. Analytics watches
 * spending and can raise an alert, but it never decides: a brake that stops
 * working when the dashboard is slow is not a brake.
 */

/**
 * **The founder switch: do calls that failed at the vendor count towards the
 * caps?** This constant is the whole answer; flip it here and every cap, every
 * query and every test follows.
 *
 * The problem it settles: when a paid call fails, neither vendor tells us what
 * the attempt cost, so the ledger stores our own estimate and marks the row
 * `failed`. DataForSEO very likely bills nothing for a request it rejected as
 * malformed, so counting those rows probably over-counts — and an over-counting
 * meter pauses the product for money that never left.
 *
 * It is `true` — failures count — because the failure this brake exists to
 * catch is a runaway loop, and a runaway loop's calls mostly *fail*: a retry
 * storm, a bad prompt version rejected over and over, a credential that stopped
 * working. Excluding failures would blind the meter to the exact shape of
 * disaster it is here for. The two errors are not symmetric either: counting
 * too much pauses one account until an operator looks, which is recoverable in
 * minutes; counting too little runs an unbounded bill, which is not.
 *
 * Cost of leaving it `true`: an account can be paused over estimated money that
 * was never charged. Set it to `false` and the caps sum only calls the vendor
 * completed.
 */
export const COUNT_FAILED_VENDOR_CALLS = true

/**
 * Raised when one account's daily model spend runs away. It pauses that
 * account's work and nothing else — other stores keep running, and the paused
 * store keeps every screen it could read before.
 */
export const ACCOUNT_PAUSED_FLAG = 'account.pause_generation'

/** The master switch. While it is active no account's work runs at all. */
export const ALL_WORK_PAUSED_FLAG = 'global.pause_all'

/**
 * Raised when the day's search-data bill crosses its ceiling. Search data is
 * bought against one vendor account, so the ceiling is global and so is the
 * pause. Nothing reads this flag yet — the enrichment work it would stop is
 * not built.
 */
export const ENRICHMENT_PAUSED_FLAG = 'global.pause_enrichment'

const MS_PER_DAY = 86_400_000

export interface DayWindow {
  /** Inclusive. */
  since: Date
  /** Exclusive. */
  until: Date
}

/**
 * "Today", as the caps mean it: midnight to midnight UTC.
 *
 * Not the merchant's local day, deliberately. The vendors bill us on their
 * clock, not on each store's, and a per-store day would give the same dollar
 * two different days depending on who spent it — so the same runaway would trip
 * at different totals for a Copenhagen store and a Los Angeles one.
 */
export function utcDayWindow(now: Date): DayWindow {
  const since = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  )
  return { since, until: new Date(since.getTime() + MS_PER_DAY) }
}

/**
 * The days before today that the "far more than it normally does" rule looks
 * back over. It stops where today starts: a day cannot be unusual compared with
 * a typical day that includes itself.
 */
export function trailingWindow(now: Date, days: number): DayWindow {
  const today = utcDayWindow(now)
  return { since: new Date(today.since.getTime() - days * MS_PER_DAY), until: today.since }
}

/** The middle value; the mean of the middle two when the count is even. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const value = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  return value ?? null
}

/** How money is written in a flag's reason, so two trips read the same way. */
export function usd(amount: number): string {
  return `$${amount.toFixed(2)}`
}

export type AccountSpendTrip = 'hard_cap' | 'unusual_for_this_account'

export interface AccountSpendVerdict {
  tripped: boolean
  /** Which of the two rules fired. The hard cap wins when both do. */
  rule: AccountSpendTrip | null
  todayUsd: number
  /** A typical day's spend for this account, or null when it has no history to compare with. */
  typicalDayUsd: number | null
  /** Written for the operator who finds the flag, from the numbers above and nothing else. */
  reason: string | null
}

export interface AccountSpendInput {
  todayUsd: number
  /**
   * One entry per earlier day on which this account spent anything. Days with
   * no spend are absent on purpose: counting them as zero would make a typical
   * day cost nothing for any account that does not work daily, and then any
   * spending at all would look like a runaway.
   */
  earlierDailyTotalsUsd: readonly number[]
  /** From `packages/rules`: the ceiling no account's day may cross, whatever its habits. */
  hardCapUsdPerDay: number
  /** From `packages/rules`: how many times a typical day counts as running away. */
  medianMultipleMax: number
}

/**
 * The per-account rule, which is two rules: a flat ceiling that catches any
 * account, and a comparison against the account's own history that catches a
 * store spending far more than it normally does while still well under the
 * ceiling.
 *
 * The comparison is skipped when there is no history to compare against — a
 * brand-new account, or one whose earlier days all cost nothing. It is then the
 * flat ceiling alone, which is the honest answer: the first day of a store's
 * life has nothing to be unusual against.
 */
export function accountSpendVerdict(input: AccountSpendInput): AccountSpendVerdict {
  const typical = median(input.earlierDailyTotalsUsd)

  if (input.todayUsd > input.hardCapUsdPerDay) {
    return {
      tripped: true,
      rule: 'hard_cap',
      todayUsd: input.todayUsd,
      typicalDayUsd: typical,
      reason:
        `Model spend for this account reached ${usd(input.todayUsd)} today, over the ` +
        `${usd(input.hardCapUsdPerDay)} daily ceiling. Work is paused until an operator resets this.`,
    }
  }

  if (typical !== null && typical > 0 && input.todayUsd > typical * input.medianMultipleMax) {
    return {
      tripped: true,
      rule: 'unusual_for_this_account',
      todayUsd: input.todayUsd,
      typicalDayUsd: typical,
      reason:
        `Model spend for this account reached ${usd(input.todayUsd)} today against a typical ` +
        `day of ${usd(typical)} — more than ${input.medianMultipleMax}x its own normal. Work is ` +
        `paused until an operator resets this.`,
    }
  }

  return {
    tripped: false,
    rule: null,
    todayUsd: input.todayUsd,
    typicalDayUsd: typical,
    reason: null,
  }
}

export interface GlobalSpendVerdict {
  tripped: boolean
  todayUsd: number
  reason: string | null
}

/**
 * A flat ceiling on a day's total, used where the bill is one bill for the
 * whole product: the search-data account, and the logged-out preview.
 *
 * `what` names the spending in the flag's reason — it is read by whoever finds
 * the flag, so it is a phrase, not an identifier.
 */
export function globalSpendVerdict(input: {
  todayUsd: number
  capUsdPerDay: number
  what: string
}): GlobalSpendVerdict {
  if (input.todayUsd > input.capUsdPerDay) {
    return {
      tripped: true,
      todayUsd: input.todayUsd,
      reason:
        `${input.what} reached ${usd(input.todayUsd)} today, over the ${usd(input.capUsdPerDay)} ` +
        `daily cap. Paused until an operator resets this.`,
    }
  }
  return { tripped: false, todayUsd: input.todayUsd, reason: null }
}

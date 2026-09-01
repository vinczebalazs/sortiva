import { describe, expect, it } from 'vitest'
import {
  COUNT_FAILED_VENDOR_CALLS,
  accountSpendVerdict,
  globalSpendVerdict,
  median,
  trailingWindow,
  utcDayWindow,
} from './spend-caps'

/**
 * The arithmetic behind the money brakes, tested without a database.
 *
 * The numbers here are written out rather than read from `packages/rules`
 * deliberately: this suite proves the comparison behaves, and a suite that took
 * its expectations from the same file as the code could not tell a wrong
 * comparison from a changed ceiling.
 */

const HARD_CAP = 5
const MULTIPLE = 10

function verdictAt(todayUsd: number, earlier: number[] = []) {
  return accountSpendVerdict({
    todayUsd,
    earlierDailyTotalsUsd: earlier,
    hardCapUsdPerDay: HARD_CAP,
    medianMultipleMax: MULTIPLE,
  })
}

describe('the flat ceiling', () => {
  it('does not trip at the ceiling exactly', () => {
    expect(verdictAt(HARD_CAP).tripped).toBe(false)
  })

  it('trips a cent over it', () => {
    const verdict = verdictAt(HARD_CAP + 0.01)
    expect(verdict.tripped).toBe(true)
    expect(verdict.rule).toBe('hard_cap')
  })

  it('trips regardless of how much the account normally spends', () => {
    // A store whose typical day is $4 is not "unusual" at $6, but $6 is still
    // over the ceiling. Without the flat rule this account never trips.
    expect(verdictAt(6, [4, 4, 4]).rule).toBe('hard_cap')
  })

  it('says what happened, in money and in words', () => {
    expect(verdictAt(7.5).reason).toContain('$7.50')
    expect(verdictAt(7.5).reason).toContain('$5.00')
  })
})

describe("the account's own history", () => {
  it('trips when today is more than the multiple of a typical day', () => {
    const verdict = verdictAt(2.5, [0.2, 0.2, 0.3])
    expect(verdict.tripped).toBe(true)
    expect(verdict.rule).toBe('unusual_for_this_account')
    expect(verdict.typicalDayUsd).toBe(0.2)
  })

  it('does not trip at exactly the multiple', () => {
    expect(verdictAt(2, [0.2, 0.2, 0.2]).tripped).toBe(false)
  })

  it('is skipped entirely for an account with no earlier spend', () => {
    // The first day of a store's life has nothing to be unusual against. If
    // absent history were treated as a typical day of zero, every new account
    // would trip on its first paid call.
    expect(verdictAt(4.99, []).tripped).toBe(false)
  })

  it('is skipped when every earlier day cost nothing', () => {
    expect(verdictAt(4.99, [0, 0]).tripped).toBe(false)
  })

  it('uses the middle day, not the average, so one expensive day cannot raise the bar', () => {
    // Mean of these is $2.55, ten times which is $25.50 — an account could then
    // spend $25 unnoticed. The median is $0.20.
    expect(verdictAt(3, [0.2, 0.2, 0.2, 10]).tripped).toBe(true)
  })
})

describe('the flat ceilings that cover everyone', () => {
  it('trips over the cap and names the spending', () => {
    const verdict = globalSpendVerdict({
      todayUsd: 51,
      capUsdPerDay: 50,
      what: 'Search-data spend across all accounts',
    })
    expect(verdict.tripped).toBe(true)
    expect(verdict.reason).toContain('Search-data spend across all accounts')
    expect(verdict.reason).toContain('$51.00')
  })

  it('does not trip at the cap', () => {
    expect(globalSpendVerdict({ todayUsd: 50, capUsdPerDay: 50, what: 'x' }).tripped).toBe(false)
  })
})

describe('the windows', () => {
  it('measures a day from midnight UTC to midnight UTC', () => {
    const { since, until } = utcDayWindow(new Date('2026-09-01T22:41:07.500Z'))
    expect(since.toISOString()).toBe('2026-09-01T00:00:00.000Z')
    expect(until.toISOString()).toBe('2026-09-02T00:00:00.000Z')
  })

  it('stops the history where today begins, so today is not compared with itself', () => {
    const { since, until } = trailingWindow(new Date('2026-09-01T22:41:07.500Z'), 30)
    expect(until.toISOString()).toBe('2026-09-01T00:00:00.000Z')
    expect(since.toISOString()).toBe('2026-08-02T00:00:00.000Z')
  })
})

describe('median', () => {
  it('is null with nothing to average', () => {
    expect(median([])).toBeNull()
  })

  it('takes the middle of an odd count and the mean of the middle two of an even one', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
})

describe('the failed-call policy', () => {
  it('is a single exported switch, so the founder flips one thing', () => {
    // The value itself is a decision, journalled in DECISIONS.md; this only
    // holds that it stays one boolean in one place rather than spreading into
    // per-query options.
    expect(typeof COUNT_FAILED_VENDOR_CALLS).toBe('boolean')
  })
})

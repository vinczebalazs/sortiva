import { describe, expect, it } from 'vitest'
import { isScanWeekday, nextWeeklyScanAt, scanLocalDay, weeklyScanRunId } from './next-scan'

/**
 * 2026-09-07 is a Monday; 2026-09-09 is a Wednesday. Both are used as literal
 * instants rather than derived, so a reader can check the weekday by hand.
 */
const MONDAY_MIDDAY_UTC = new Date('2026-09-07T12:00:00.000Z')
const WEDNESDAY_MIDDAY_UTC = new Date('2026-09-09T12:00:00.000Z')

const running = { scanRuns: true, currentLocalDayAlreadyScanned: false }

describe('scanLocalDay — the store\'s own week, not ours', () => {
  it('reads the date and weekday where the merchant is', () => {
    expect(scanLocalDay(MONDAY_MIDDAY_UTC, 'UTC')).toEqual({ date: '2026-09-07', weekday: 'Mon' })
  })

  it('a store far enough east is already on the next day', () => {
    // 12:00 UTC Monday is 00:00 Tuesday in Auckland (UTC+12 in September).
    expect(scanLocalDay(MONDAY_MIDDAY_UTC, 'Pacific/Auckland')).toEqual({
      date: '2026-09-08',
      weekday: 'Tue',
    })
  })

  it('a store far enough west is still on the previous day', () => {
    // 01:00 UTC Monday is 18:00 Sunday in Los Angeles.
    const day = scanLocalDay(new Date('2026-09-07T01:00:00.000Z'), 'America/Los_Angeles')
    expect(day).toEqual({ date: '2026-09-06', weekday: 'Sun' })
    expect(isScanWeekday(day)).toBe(false)
  })

  it('an unparseable zone falls back to UTC rather than dropping the store', () => {
    expect(scanLocalDay(MONDAY_MIDDAY_UTC, 'Not/AZone')).toEqual({
      date: '2026-09-07',
      weekday: 'Mon',
    })
  })
})

describe('weeklyScanRunId', () => {
  it('names the store and its own Monday, so a second wake-up the same day is a no-op', () => {
    expect(weeklyScanRunId('acct-1', '2026-09-07')).toBe('weekly-acct-1-2026-09-07')
  })
})

describe('nextWeeklyScanAt — the date comes from the sweep\'s own next matching wake-up', () => {
  it('a store whose Monday has not been scanned yet is scanned at the next wake-up, today', () => {
    const at = nextWeeklyScanAt({
      now: new Date('2026-09-07T12:20:00.000Z'),
      timeZone: 'UTC',
      ...running,
    })
    expect(at?.toISOString()).toBe('2026-09-07T13:00:00.000Z')
  })

  it('asked exactly as the sweep wakes, that wake-up is the answer rather than the one after it', () => {
    const at = nextWeeklyScanAt({ now: MONDAY_MIDDAY_UTC, timeZone: 'UTC', ...running })
    expect(at?.toISOString()).toBe('2026-09-07T12:00:00.000Z')
  })

  it('mid-week, the answer is the store\'s own next local Monday midnight, rounded to a wake-up', () => {
    const at = nextWeeklyScanAt({ now: WEDNESDAY_MIDDAY_UTC, timeZone: 'UTC', ...running })
    expect(at?.toISOString()).toBe('2026-09-14T00:00:00.000Z')
  })

  it('a Berlin store is scanned at its own midnight, which is the hour before ours', () => {
    const at = nextWeeklyScanAt({ now: WEDNESDAY_MIDDAY_UTC, timeZone: 'Europe/Berlin', ...running })
    // 00:00 Monday in Berlin (UTC+2 in September) is 22:00 Sunday UTC.
    expect(at?.toISOString()).toBe('2026-09-13T22:00:00.000Z')
  })

  it('an Auckland store reaches Monday well before a UTC one — the same cadence, a different instant', () => {
    const at = nextWeeklyScanAt({ now: WEDNESDAY_MIDDAY_UTC, timeZone: 'Pacific/Auckland', ...running })
    // 00:00 Monday in Auckland (UTC+12) is 12:00 Sunday UTC.
    expect(at?.toISOString()).toBe('2026-09-13T12:00:00.000Z')
    expect(at!.getTime()).toBeLessThan(
      nextWeeklyScanAt({ now: WEDNESDAY_MIDDAY_UTC, timeZone: 'UTC', ...running })!.getTime(),
    )
  })

  it('a store whose zone puts midnight on a half hour is scanned at the next whole hour, never before its Monday', () => {
    const at = nextWeeklyScanAt({ now: WEDNESDAY_MIDDAY_UTC, timeZone: 'Asia/Kolkata', ...running })
    // 00:00 Monday in Kolkata (UTC+5:30) is 18:30 Sunday UTC; the sweep wakes at 19:00.
    expect(at?.toISOString()).toBe('2026-09-13T19:00:00.000Z')
    expect(scanLocalDay(at!, 'Asia/Kolkata')).toEqual({ date: '2026-09-14', weekday: 'Mon' })
  })

  it('this Monday\'s pass having already finished moves the answer on a week rather than promising it again', () => {
    const at = nextWeeklyScanAt({
      now: MONDAY_MIDDAY_UTC,
      timeZone: 'UTC',
      scanRuns: true,
      currentLocalDayAlreadyScanned: true,
    })
    expect(at?.toISOString()).toBe('2026-09-14T00:00:00.000Z')
  })

  it('never answers with a moment in the past', () => {
    for (const zone of ['UTC', 'Europe/Berlin', 'Pacific/Auckland', 'America/Los_Angeles']) {
      for (const now of [MONDAY_MIDDAY_UTC, WEDNESDAY_MIDDAY_UTC]) {
        const at = nextWeeklyScanAt({ now, timeZone: zone, ...running })
        expect(at!.getTime()).toBeGreaterThanOrEqual(now.getTime())
        expect(isScanWeekday(scanLocalDay(at!, zone))).toBe(true)
      }
    }
  })

  it('a store whose scan is not going to run is told nothing, whatever day it is', () => {
    for (const now of [MONDAY_MIDDAY_UTC, WEDNESDAY_MIDDAY_UTC]) {
      expect(
        nextWeeklyScanAt({ now, timeZone: 'UTC', scanRuns: false, currentLocalDayAlreadyScanned: false }),
      ).toBeNull()
    }
  })
})

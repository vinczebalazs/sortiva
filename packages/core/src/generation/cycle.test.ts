import { describe, expect, it } from 'vitest'
import { billingGate } from '../billing/entitlement'
import { lifecycleGate, type LifecycleGate } from '../lifecycle/gate'
import {
  decideDequeue,
  generationHourFor,
  localClock,
  publishDayFor,
  type DequeueInput,
} from './cycle'
import { landingForPass } from './review'

/**
 * The order the reasons to stop are consulted in, and the rule that a day with
 * nothing planned produces nothing.
 */

const OPEN = { allowed: true } as const

function gateWith(over: Partial<Parameters<typeof lifecycleGate>[0]> = {}): LifecycleGate {
  return lifecycleGate({
    billing: billingGate({ status: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: null }),
    vacationMode: false,
    deletionRequestedAt: null,
    ...over,
  })
}

function input(over: Partial<DequeueInput> = {}): DequeueInput {
  return {
    switches: OPEN,
    lifecycle: gateWith(),
    shopify: 'connected',
    hasPlannedTopicToday: true,
    ...over,
  }
}

describe('decideDequeue', () => {
  it('allows a paid-up, connected store with a topic planned for today', () => {
    expect(decideDequeue(input())).toEqual({ allowed: true })
  })

  it('stops on a kill switch and names which one', () => {
    const decision = decideDequeue(
      input({ switches: { allowed: false, reason: 'paused', flag: 'account.pause_generation' } }),
    )
    expect(decision).toEqual({ allowed: false, reason: 'paused', flag: 'account.pause_generation' })
  })

  it('stops when the switches cannot be read at all', () => {
    const decision = decideDequeue(
      input({ switches: { allowed: false, reason: 'unreadable', detail: 'connection refused' } }),
    )
    expect(decision).toEqual({ allowed: false, reason: 'switches_unreadable' })
  })

  it('stops an account whose payment failed', () => {
    const lifecycle = gateWith({
      billing: billingGate({ status: 'past_due', cancelAtPeriodEnd: false, currentPeriodEnd: null }),
    })
    expect(decideDequeue(input({ lifecycle }))).toEqual({ allowed: false, reason: 'not_entitled' })
  })

  it('stops an account with no subscription row at all', () => {
    expect(decideDequeue(input({ lifecycle: gateWith({ billing: billingGate(null) }) }))).toEqual({
      allowed: false,
      reason: 'not_entitled',
    })
  })

  it('stops a merchant who is away', () => {
    expect(decideDequeue(input({ lifecycle: gateWith({ vacationMode: true }) }))).toEqual({
      allowed: false,
      reason: 'vacation',
    })
  })

  it('stops a store we can no longer reach', () => {
    expect(decideDequeue(input({ shopify: 'lost' }))).toEqual({
      allowed: false,
      reason: 'shopify_disconnected',
    })
    expect(decideDequeue(input({ shopify: 'never_connected' }))).toEqual({
      allowed: false,
      reason: 'shopify_disconnected',
    })
  })

  it('writes nothing on a day with nothing planned', () => {
    expect(decideDequeue(input({ hasPlannedTopicToday: false }))).toEqual({
      allowed: false,
      reason: 'no_topic_today',
    })
  })

  /**
   * The order matters because each check costs more than the one before it, and
   * because an operator brake must win over everything: a store that is paused,
   * unpaid, on holiday and disconnected all at once reports the pause.
   */
  it('reports the earliest reason when several apply at once', () => {
    const everything = input({
      switches: { allowed: false, reason: 'paused', flag: 'global.pause_all' },
      lifecycle: gateWith({
        billing: billingGate({ status: 'past_due', cancelAtPeriodEnd: false, currentPeriodEnd: null }),
        vacationMode: true,
        deletionRequestedAt: new Date('2026-09-01T00:00:00.000Z'),
      }),
      shopify: 'lost',
      hasPlannedTopicToday: false,
    })
    expect(decideDequeue(everything)).toMatchObject({ reason: 'paused' })

    const noSwitch = decideDequeue({ ...everything, switches: OPEN })
    expect(noSwitch).toMatchObject({ reason: 'deleted' })

    const paidUpAndAlive = decideDequeue({
      ...everything,
      switches: OPEN,
      lifecycle: gateWith({ vacationMode: true }),
    })
    expect(paidUpAndAlive).toMatchObject({ reason: 'vacation' })

    const backFromHoliday = decideDequeue({ ...everything, switches: OPEN, lifecycle: gateWith() })
    expect(backFromHoliday).toMatchObject({ reason: 'shopify_disconnected' })

    const allClear = decideDequeue({
      ...everything,
      switches: OPEN,
      lifecycle: gateWith(),
      shopify: 'connected',
    })
    expect(allClear).toMatchObject({ reason: 'no_topic_today' })
  })
})

describe('the account clock', () => {
  const noon = new Date('2026-09-03T12:00:00.000Z')

  it('reads the date and hour where the merchant is, not where we are', () => {
    expect(localClock(noon, 'UTC')).toEqual({ date: '2026-09-03', hour: 12 })
    expect(localClock(noon, 'Europe/Berlin')).toEqual({ date: '2026-09-03', hour: 14 })
    expect(localClock(noon, 'America/Los_Angeles')).toEqual({ date: '2026-09-03', hour: 5 })
  })

  it('gives a store far enough east its own next day', () => {
    const lateUtc = new Date('2026-09-03T23:00:00.000Z')
    expect(localClock(lateUtc, 'Pacific/Auckland').date).toBe('2026-09-04')
  })

  it('falls back to UTC for a zone it cannot parse, rather than skipping the store', () => {
    expect(localClock(noon, 'Not/AZone')).toEqual({ date: '2026-09-03', hour: 12 })
  })
})

describe('generationHourFor', () => {
  it('starts the run a fixed lead ahead of the publish hour', () => {
    expect(generationHourFor(9, 6)).toBe(3)
    expect(generationHourFor(18, 6)).toBe(12)
  })

  it('wraps to the evening before rather than losing the runway', () => {
    expect(generationHourFor(2, 6)).toBe(20)
    expect(generationHourFor(0, 1)).toBe(23)
  })
})

describe('publishDayFor', () => {
  /**
   * The lead the running product uses. Named here rather than read from
   * `packages/rules` so the arithmetic under test does not move when the
   * number does.
   */
  const LEAD = 6

  it('gives the same day for a store publishing in its own morning', () => {
    // 03:00 in Berlin on the 3rd: writing starts, the article is due at 09:00
    // the same morning.
    expect(publishDayFor(new Date('2026-09-03T01:00:00.000Z'), 'Europe/Berlin', LEAD)).toBe('2026-09-03')
  })

  it('gives tomorrow to a store publishing after midnight, so the calendar and the shop agree', () => {
    // A Berlin store with a 02:00 publish hour starts writing at 20:00 on the
    // 2nd. The article appears on the 3rd, so the 3rd's topic is the one it
    // must take — reading the clock at the writing moment would take the 2nd's
    // and publish it a day late, for ever.
    expect(publishDayFor(new Date('2026-09-02T18:00:00.000Z'), 'Europe/Berlin', LEAD)).toBe('2026-09-03')
  })

  it('reads the date where the audience is, not where the server is', () => {
    // 20:00 on the 2nd in Los Angeles is already the 3rd in UTC. A store
    // publishing at 02:00 local takes the 3rd's topic — its own 3rd.
    expect(publishDayFor(new Date('2026-09-03T03:00:00.000Z'), 'America/Los_Angeles', LEAD)).toBe(
      '2026-09-03',
    )
    // The same instant for a Tokyo store, whose day has already turned twice
    // over: 12:00 on the 3rd, publishing at 18:00 the same afternoon.
    expect(publishDayFor(new Date('2026-09-03T03:00:00.000Z'), 'Asia/Tokyo', LEAD)).toBe('2026-09-03')
  })

  it('falls back to UTC for a zone it cannot parse rather than skipping the store', () => {
    expect(publishDayFor(new Date('2026-09-03T01:00:00.000Z'), 'Mars/Olympus', LEAD)).toBe('2026-09-03')
  })
})

describe('where a passing draft lands', () => {
  it('waits for the merchant only when they asked to be asked', () => {
    expect(landingForPass(true)).toEqual({
      articleState: 'in_review',
      topicState: 'in_review',
      awaitsReview: true,
    })
    expect(landingForPass(false)).toEqual({
      articleState: 'draft',
      topicState: 'generating',
      awaitsReview: false,
    })
  })
})

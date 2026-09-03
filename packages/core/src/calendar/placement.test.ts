import { describe, expect, it } from 'vitest'
import {
  CalendarHorizonExceededError,
  earliestSchedulableDate,
  pickOpenDate,
  planMove,
  planPin,
  type OccupantTopic,
} from './placement'

describe('pickOpenDate', () => {
  it('returns the preferred date when nothing occupies it', () => {
    expect(pickOpenDate(new Set(), '2026-04-01')).toBe('2026-04-01')
  })

  it('skips forward past every occupied day', () => {
    const occupied = new Set(['2026-04-01', '2026-04-02', '2026-04-03'])
    expect(pickOpenDate(occupied, '2026-04-01')).toBe('2026-04-04')
  })

  it('throws once the horizon is exhausted rather than looping forever', () => {
    const occupied = new Set(['2026-04-01'])
    expect(() => pickOpenDate(occupied, '2026-04-01', 1)).toThrow(CalendarHorizonExceededError)
  })
})

describe('earliestSchedulableDate', () => {
  it('is tomorrow, never today', () => {
    expect(earliestSchedulableDate('2026-04-01')).toBe('2026-04-02')
  })
})

function topic(overrides: Partial<OccupantTopic> = {}): OccupantTopic {
  return { id: 't1', state: 'planned', pinned: false, scheduledFor: '2026-04-05', ...overrides }
}

describe('planMove', () => {
  const today = '2026-04-01'

  it('allows a plain move onto an empty future day', () => {
    const plan = planMove({ topic: topic(), toDate: '2026-04-10', occupant: null, today })
    expect(plan).toEqual({ ok: true, swap: false })
  })

  it('refuses a topic that is not planned', () => {
    const plan = planMove({
      topic: topic({ state: 'generating' }),
      toDate: '2026-04-10',
      occupant: null,
      today,
    })
    expect(plan).toEqual({ ok: false, code: 'topic_already_generating' })
  })

  it('refuses dragging a pinned topic', () => {
    const plan = planMove({
      topic: topic({ pinned: true }),
      toDate: '2026-04-10',
      occupant: null,
      today,
    })
    expect(plan).toEqual({ ok: false, code: 'topic_pinned' })
  })

  it('refuses dropping onto a pinned occupant', () => {
    const plan = planMove({
      topic: topic(),
      toDate: '2026-04-10',
      occupant: topic({ id: 't2', pinned: true, scheduledFor: '2026-04-10' }),
      today,
    })
    expect(plan).toEqual({ ok: false, code: 'topic_pinned' })
  })

  it('refuses a date in the past', () => {
    const plan = planMove({ topic: topic(), toDate: '2026-03-31', occupant: null, today })
    expect(plan).toEqual({ ok: false, code: 'calendar_date_in_past' })
  })

  it('swaps with an unpinned, planned occupant', () => {
    const plan = planMove({
      topic: topic(),
      toDate: '2026-04-10',
      occupant: topic({ id: 't2', scheduledFor: '2026-04-10' }),
      today,
    })
    expect(plan).toEqual({ ok: true, swap: true })
  })

  it('refuses a swap when the occupant itself cannot move', () => {
    const plan = planMove({
      topic: topic(),
      toDate: '2026-04-10',
      occupant: topic({ id: 't2', state: 'in_review', scheduledFor: '2026-04-10' }),
      today,
    })
    expect(plan).toEqual({ ok: false, code: 'topic_already_published' })
  })
})

describe('planPin', () => {
  it('allows pinning a planned topic', () => {
    expect(planPin('planned')).toEqual({ ok: true })
  })

  it('refuses pinning an already-published topic', () => {
    expect(planPin('published')).toEqual({ ok: false, code: 'topic_already_published' })
  })
})

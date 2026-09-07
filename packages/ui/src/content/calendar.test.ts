import { describe, expect, it, vi } from 'vitest'
import catalogue from '../../strings/en.json'
import { t } from '../strings'
import {
  acceptsTopic,
  addMonths,
  daysBetween,
  monthGrid,
  moveOutcome,
  positionOf,
  startOfMonth,
  topicStateLabel,
  vetoKind,
} from './calendar'
import { calendarConflictMessage, createCalendarActions, type CalendarApi } from './actions'
import type { CalendarTopic } from './types'

/**
 * The calendar's promises, checked without a browser.
 *
 * The one that matters most is the quiet one: a day that produced nothing is
 * not a failure and the screen must never say it was. That is a rule about what
 * is *absent*, which is exactly the kind of thing that survives a review and
 * then quietly stops being true, so it is asserted here in three ways — no
 * marker on a past empty day, no way to add to one, and no way to drag anything
 * onto one.
 */

const TODAY = '2026-09-15'

function topic(overrides: Partial<CalendarTopic> = {}): CalendarTopic {
  return {
    id: 'topic-1',
    title: 'Best trail shoes for wide feet',
    scheduledFor: '2026-09-20',
    state: 'planned',
    intentClass: 'buying_guide',
    kind: 'new',
    source: 'auto',
    pinned: false,
    targetKeyword: 'trail shoes wide feet',
    monthlySearchVolume: 880,
    why: { templateKey: 'uncovered_commercial_query.create', params: { volume: 880 } },
    opportunityId: 'opp-1',
    signalType: 'uncovered_commercial_query',
    articleId: null,
    rejection: null,
    ...overrides,
  }
}

describe('the month a merchant is looking at', () => {
  it('always has six rows of seven days, so paging does not change its height', () => {
    const grid = monthGrid('2026-09-01', [], TODAY)
    expect(grid.weeks).toHaveLength(6)
    for (const week of grid.weeks) expect(week).toHaveLength(7)
  })

  it('starts each week on Monday, and marks the days that spill in from either side', () => {
    const grid = monthGrid('2026-09-01', [], TODAY)
    // 1 September 2026 is a Tuesday, so the row starts on 31 August.
    expect(grid.weeks[0]![0]!.date).toBe('2026-08-31')
    expect(grid.weeks[0]![0]!.inMonth).toBe(false)
    expect(grid.weeks[0]![1]!.date).toBe('2026-09-01')
    expect(grid.weeks[0]![1]!.inMonth).toBe(true)
    expect(grid.days).toHaveLength(30)
  })

  it('puts a topic on its own day and nowhere else', () => {
    const grid = monthGrid('2026-09-01', [topic()], TODAY)
    const day = grid.days.find((entry) => entry.date === '2026-09-20')
    expect(day?.topic?.id).toBe('topic-1')
    expect(grid.days.filter((entry) => entry.topic !== null)).toHaveLength(1)
  })

  it('keeps the first of two topics sent for one day rather than letting the later one win silently', () => {
    const grid = monthGrid(
      '2026-09-01',
      [topic(), topic({ id: 'topic-2', title: 'Second' })],
      TODAY,
    )
    expect(grid.days.find((entry) => entry.date === '2026-09-20')?.topic?.id).toBe('topic-1')
  })
})

describe('a day with nothing on it', () => {
  const grid = monthGrid('2026-09-01', [], TODAY)
  const past = grid.days.find((day) => day.date === '2026-09-03')!
  const future = grid.days.find((day) => day.date === '2026-09-25')!
  const today = grid.days.find((day) => day.date === TODAY)!

  it('renders nothing at all once it has passed', () => {
    expect(past.position).toBe('past')
    expect(past.emptyTreatment).toBe('blank')
  })

  it('is an opening rather than a hole while it is still ahead', () => {
    expect(future.emptyTreatment).toBe('open')
  })

  it('offers nothing on today either, because a day that has arrived cannot be caught up on', () => {
    expect(today.position).toBe('today')
    expect(today.emptyTreatment).toBe('blank')
    expect(acceptsTopic(TODAY, TODAY)).toBe(false)
  })

  it('never counts empty days, in any form the grid produces', () => {
    // Nothing on a CalendarDay is a tally: the shape carries a date, a
    // position, a topic and a treatment, and adding a count here is what would
    // let a screen render "3 missed" without anyone noticing.
    expect(Object.keys(past).sort()).toEqual(['date', 'emptyTreatment', 'inMonth', 'position', 'topic'])
  })
})

describe('dragging a topic', () => {
  it('moves it to an empty future day', () => {
    expect(moveOutcome(topic(), '2026-09-25', null, TODAY)).toEqual({ ok: true, swap: false })
  })

  it('swaps it with whatever is already on the day it lands on', () => {
    const occupant = topic({ id: 'topic-2', scheduledFor: '2026-09-25' })
    expect(moveOutcome(topic(), '2026-09-25', occupant, TODAY)).toEqual({ ok: true, swap: true })
  })

  it('refuses to move a pinned topic', () => {
    expect(moveOutcome(topic({ pinned: true }), '2026-09-25', null, TODAY)).toEqual({
      ok: false,
      reason: 'pinned',
    })
  })

  it('refuses to displace a pinned topic, which is the other half of the same promise', () => {
    const occupant = topic({ id: 'topic-2', scheduledFor: '2026-09-25', pinned: true })
    expect(moveOutcome(topic(), '2026-09-25', occupant, TODAY)).toEqual({
      ok: false,
      reason: 'occupant_pinned',
    })
  })

  it('refuses a day that has already passed, and today as well', () => {
    expect(moveOutcome(topic(), '2026-09-03', null, TODAY)).toEqual({
      ok: false,
      reason: 'date_in_past',
    })
    expect(moveOutcome(topic(), TODAY, null, TODAY)).toEqual({ ok: false, reason: 'date_in_past' })
  })

  it('refuses to move a topic that is already being written', () => {
    expect(moveOutcome(topic({ state: 'generating' }), '2026-09-25', null, TODAY)).toEqual({
      ok: false,
      reason: 'not_movable',
    })
  })
})

describe('the two vetoes', () => {
  it('is a free removal while the topic is only planned', () => {
    expect(vetoKind(topic())).toBe('remove')
    expect(vetoKind(topic({ state: 'checking' }))).toBe('remove')
  })

  it('becomes a decision not to publish once the draft exists', () => {
    expect(vetoKind(topic({ state: 'generating' }))).toBe('cancel_publication')
    expect(vetoKind(topic({ state: 'in_review' }))).toBe('cancel_publication')
  })

  it('is gone once the outcome is settled', () => {
    expect(vetoKind(topic({ state: 'published' }))).toBe('unavailable')
    expect(vetoKind(topic({ state: 'rejected_by_gate' }))).toBe('unavailable')
  })
})

describe('dates', () => {
  it('classifies past, today and future against the day the server named', () => {
    expect(positionOf('2026-09-14', TODAY)).toBe('past')
    expect(positionOf(TODAY, TODAY)).toBe('today')
    expect(positionOf('2026-09-16', TODAY)).toBe('future')
  })

  it('counts whole days between two dates, in either direction', () => {
    expect(daysBetween(TODAY, '2026-09-20')).toBe(5)
    expect(daysBetween('2026-09-20', TODAY)).toBe(-5)
  })

  it('steps months without falling off the end of a short one', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-01')
    expect(startOfMonth('2026-09-15')).toBe('2026-09-01')
  })
})

// ── What the actions do ─────────────────────────────────────────────────────

function surface() {
  const toasts: { message: string; undoLabel?: string; onUndo?: () => void }[] = []
  const hidden = new Set<string>()
  const refusals: { date: string; message: string }[] = []
  let refreshes = 0
  return {
    toasts,
    hidden,
    refusals,
    get refreshes() {
      return refreshes
    },
    surface: {
      toast: (toast: { id: string; message: string; undoLabel?: string; onUndo?: () => void }) =>
        toasts.push(toast),
      refresh: () => {
        refreshes += 1
      },
      setHidden: (id: string, is: boolean) => {
        if (is) hidden.add(id)
        else hidden.delete(id)
      },
      setBusy: () => {},
      refuse: (date: string, message: string) => refusals.push({ date, message }),
    },
  }
}

function api(overrides: Partial<CalendarApi> = {}): CalendarApi & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    load: async () => null,
    post: async (path) => {
      calls.push(`calendar ${path}`)
      return { ok: true }
    },
    opportunityPost: async (path) => {
      calls.push(`opportunities ${path}`)
      return { ok: true }
    },
    ...overrides,
  } as CalendarApi & { calls: string[] }
}

describe('vetoing a topic', () => {
  it('takes the opportunity behind it with the same click, once the undo window has closed', async () => {
    vi.useFakeTimers()
    const client = api()
    const view = surface()
    const actions = createCalendarActions(client, view.surface, { undoMs: 5000 })

    const done = actions.veto(topic())
    // The chip goes at once: a card that lingers reads as a button that failed.
    expect(view.hidden.has('topic-1')).toBe(true)
    expect(client.calls).toEqual([])

    await vi.advanceTimersByTimeAsync(5000)
    await done

    expect(client.calls).toEqual(['calendar /topics/topic-1/veto', 'opportunities /opp-1/dismiss'])
    vi.useRealTimers()
  })

  it('sends nothing at all when the merchant presses Undo', async () => {
    vi.useFakeTimers()
    const client = api()
    const view = surface()
    const actions = createCalendarActions(client, view.surface, { undoMs: 5000 })

    const done = actions.veto(topic())
    view.toasts[0]!.onUndo!()
    await done
    await vi.advanceTimersByTimeAsync(10_000)

    expect(client.calls).toEqual([])
    expect(view.hidden.has('topic-1')).toBe(false)
    expect(view.toasts.at(-1)!.message).toBe(t('content.toast.restored'))
    vi.useRealTimers()
  })

  it('sends a veto still waiting when the merchant leaves the screen', async () => {
    vi.useFakeTimers()
    const client = api()
    const view = surface()
    const actions = createCalendarActions(client, view.surface, { undoMs: 5000 })

    void actions.veto(topic())
    await actions.flush()

    expect(client.calls).toEqual(['calendar /topics/topic-1/veto', 'opportunities /opp-1/dismiss'])
    vi.useRealTimers()
  })

  it('puts the chip back and says what happened when the topic had already published', async () => {
    vi.useFakeTimers()
    const client = api({
      post: async () => ({ ok: false, conflict: 'topic_already_published' }),
    })
    const view = surface()
    const actions = createCalendarActions(client, view.surface, { undoMs: 1000 })

    const done = actions.veto(topic())
    await vi.advanceTimersByTimeAsync(1000)
    await done

    expect(view.hidden.has('topic-1')).toBe(false)
    expect(view.toasts.map((toast) => toast.message)).toContain(
      t('content.toast.alreadyPublished'),
    )
    expect(view.refreshes).toBeGreaterThan(0)
    vi.useRealTimers()
  })
})

describe('moving a topic', () => {
  it('sends one request for a plain move', async () => {
    const client = api()
    const view = surface()
    const actions = createCalendarActions(client, view.surface)
    await actions.move(topic(), '2026-09-25', null, TODAY)
    expect(client.calls).toEqual(['calendar /topics/topic-1/move'])
  })

  it('sends two for a swap, because the contract has no swap', async () => {
    const client = api()
    const view = surface()
    const actions = createCalendarActions(client, view.surface)
    const occupant = topic({ id: 'topic-2', scheduledFor: '2026-09-25' })
    await actions.move(topic(), '2026-09-25', occupant, TODAY)
    expect(client.calls).toEqual([
      'calendar /topics/topic-1/move',
      'calendar /topics/topic-2/move',
    ])
  })

  it('refuses a pinned drop without a round trip, and says which rule stopped it', async () => {
    const client = api()
    const view = surface()
    const actions = createCalendarActions(client, view.surface)
    const occupant = topic({ id: 'topic-2', scheduledFor: '2026-09-25', pinned: true })
    await actions.move(topic(), '2026-09-25', occupant, TODAY)

    expect(client.calls).toEqual([])
    expect(view.refusals).toEqual([
      { date: '2026-09-25', message: t('content.moveRefused.occupant_pinned') },
    ])
  })

  it('re-reads the calendar when the server refuses the move', async () => {
    const client = api({ post: async () => ({ ok: false, conflict: 'topic_already_generating' }) })
    const view = surface()
    const actions = createCalendarActions(client, view.surface)
    await actions.move(topic(), '2026-09-25', null, TODAY)

    expect(view.toasts.map((toast) => toast.message)).toEqual([
      t('content.toast.alreadyGenerating'),
    ])
    expect(view.refreshes).toBe(1)
  })
})

describe('what a refused transition says', () => {
  it('names the specific ones and falls back to a plain sentence for the rest', () => {
    expect(calendarConflictMessage('topic_pinned')).toBe(t('content.moveRefused.pinned'))
    expect(calendarConflictMessage('calendar_day_occupied')).toBe(t('content.toast.dayOccupied'))
    expect(calendarConflictMessage('something_new')).toBe(t('content.toast.conflict'))
    expect(calendarConflictMessage(null)).toBe(t('content.toast.failed'))
  })

  it('never offers a retry, because the second attempt would race exactly the same way', () => {
    for (const code of ['topic_pinned', 'calendar_day_occupied', 'topic_already_published', null]) {
      expect(calendarConflictMessage(code)).not.toMatch(/try again|retry/i)
    }
  })
})

describe('adding a topic by hand', () => {
  it('returns the gate’s answer rather than assuming it was accepted', async () => {
    const answer = {
      outcome: 'converted',
      topic: null,
      warning: null,
      convertedToOpportunityId: 'opp-9',
      rejection: null,
    }
    const client = api({ post: async () => ({ ok: true, body: answer }) })
    const view = surface()
    const actions = createCalendarActions(client, view.surface)
    expect(await actions.add({ title: 'winter fell running', date: '2026-09-25', pin: false })).toEqual(
      answer,
    )
  })

  it('says the day was taken rather than failing silently', async () => {
    const client = api({ post: async () => ({ ok: false, conflict: 'calendar_day_occupied' }) })
    const view = surface()
    const actions = createCalendarActions(client, view.surface)
    expect(await actions.add({ title: 'x', date: '2026-09-25', pin: false })).toBeNull()
    expect(view.toasts[0]!.message).toBe(t('content.toast.dayOccupied'))
  })
})

describe('the words on a chip', () => {
  it('has one for every state a topic can be in', () => {
    for (const state of [
      'planned',
      'checking',
      'generating',
      'in_review',
      'published',
      'rejected_by_gate',
      'vetoed',
    ] as const) {
      expect(topicStateLabel(state)).not.toBe('')
    }
  })

  it('never renders a count against a total, anywhere in the calendar’s copy', () => {
    const en = Object.entries(catalogue as Record<string, string>).filter(([key]) =>
      key.startsWith('content.'),
    )
    expect(en.length).toBeGreaterThan(50)
    const offenders = en.filter(([, value]) => /\d+\s*(of|\/)\s*\d+/.test(value))
    expect(offenders).toEqual([])
  })
})

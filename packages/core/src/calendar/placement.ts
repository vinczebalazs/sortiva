import { isMovable, isPinnable, moveConflictCodeFor } from './transitions'
import type { ConflictCode } from '../api/errors'

/**
 * Where a topic lands on the calendar - the part of TopicScheduler.schedule
 * (main section 8.7, the calendar's placement contract) that has nothing to
 * do with gates or opportunities: given a day the caller would prefer, and
 * the set of days already spoken for, which day does this topic actually
 * get.
 */

const DAY_MS = 86400000

function parseDay(iso: string): Date {
  return new Date(iso.slice(0, 10) + 'T00:00:00.000Z')
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function addDays(iso: string, days: number): string {
  return isoDay(new Date(parseDay(iso).getTime() + days * DAY_MS))
}

function isAfter(a: string, b: string): boolean {
  return a > b
}

export class CalendarHorizonExceededError extends Error {
  constructor(horizonDays: number) {
    super('No open calendar day found within ' + horizonDays + ' days.')
    this.name = 'CalendarHorizonExceededError'
  }
}

/**
 * The first open day at or after "from". Open means no row already occupies
 * it - occupiedDates is the caller's job to have already excluded vetoed
 * rows from (a vetoed day is an intentional gap again, main section 8.7).
 *
 * Bounded rather than an unbounded scan: a calendar that somehow has every
 * day booked for a year is a bug worth surfacing loudly, not an infinite
 * loop.
 */
export function pickOpenDate(
  occupiedDates: ReadonlySet<string>,
  from: string,
  horizonDays = 365,
): string {
  let candidate = from
  for (let i = 0; i < horizonDays; i += 1) {
    if (!occupiedDates.has(candidate)) return candidate
    candidate = addDays(candidate, 1)
  }
  throw new CalendarHorizonExceededError(horizonDays)
}

/** Today cannot take a new placement - the day's dequeue may already have run. Tomorrow is the earliest a topic may land. */
export function earliestSchedulableDate(today: string): string {
  return addDays(today, 1)
}

export interface OccupantTopic {
  readonly id: string
  readonly state: string
  readonly pinned: boolean
  readonly scheduledFor: string
}

export type MovePlan =
  | { readonly ok: true; readonly swap: false }
  | { readonly ok: true; readonly swap: true }
  | { readonly ok: false; readonly code: ConflictCode }

/**
 * Whether a drag from one day to another may proceed, and whether it swaps
 * with whatever already sits on the destination day.
 */
export function planMove(input: {
  readonly topic: OccupantTopic
  readonly toDate: string
  readonly occupant: OccupantTopic | null
  readonly today: string
}): MovePlan {
  const topic = input.topic
  const toDate = input.toDate
  const occupant = input.occupant
  const today = input.today

  if (!isMovable(topic.state)) return { ok: false, code: moveConflictCodeFor(topic.state) }
  if (topic.pinned) return { ok: false, code: 'topic_pinned' }
  if (!isAfter(toDate, today)) return { ok: false, code: 'calendar_date_in_past' }

  if (!occupant) return { ok: true, swap: false }

  if (occupant.pinned) return { ok: false, code: 'topic_pinned' }
  if (!isMovable(occupant.state)) return { ok: false, code: moveConflictCodeFor(occupant.state) }
  if (!isAfter(topic.scheduledFor, today)) return { ok: false, code: 'calendar_date_in_past' }

  return { ok: true, swap: true }
}

export type PinPlan = { readonly ok: true } | { readonly ok: false; readonly code: ConflictCode }

export function planPin(topicState: string): PinPlan {
  return isPinnable(topicState) ? { ok: true } : { ok: false, code: 'topic_already_published' }
}

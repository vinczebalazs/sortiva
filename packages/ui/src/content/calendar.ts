import { t as defaultTranslate, type StringKey, type Translate } from '../strings'
import type { CalendarTopic, TopicState } from './types'

/**
 * Everything the calendar decides before anything is drawn: which days a month
 * holds, what sits on each of them, what a day with nothing on it means, and
 * whether a topic may be dragged where the merchant dropped it.
 *
 * It is all here rather than inside the components for the same reason the
 * Opportunities screen keeps its list logic apart: the rules this file encodes
 * are the product's promises, and a promise that can only be checked by
 * rendering a month in a browser is a promise nobody checks.
 *
 * **The promise that governs this whole file is that a gap stays a gap.** The
 * scheduler takes at most one topic a day and only the one dated today; it
 * never pulls tomorrow's work forward to fill a day that produced nothing. So
 * the calendar must never offer to catch up, never present a missed day as
 * something to fix, and never imply that a run of empty days is a shortfall. A
 * past day with nothing on it renders as nothing at all — no marker, no count,
 * nothing to click — because there is nothing that happened there. A future day
 * with nothing on it is an opening rather than a hole, and says so.
 */

/** A day, and what the merchant may do with it. */
export type DayPosition = 'past' | 'today' | 'future'

export interface CalendarDay {
  /** `YYYY-MM-DD`. */
  readonly date: string
  /** False for the leading and trailing days that fill the first and last week. */
  readonly inMonth: boolean
  readonly position: DayPosition
  readonly topic: CalendarTopic | null
  /**
   * What an empty day is. `blank` renders literally nothing: a past day that
   * produced no article is not a failure, a shortfall, or a thing to fill in
   * afterwards. `open` is a future day the next replenishment can use, and is
   * the only empty day that offers anything.
   */
  readonly emptyTreatment: 'none' | 'blank' | 'open'
}

export type CalendarWeek = readonly CalendarDay[]

export interface MonthGrid {
  /** First of the month, `YYYY-MM-DD`. */
  readonly month: string
  readonly weeks: readonly CalendarWeek[]
  /** Every day of the month itself, for the week-list view. */
  readonly days: readonly CalendarDay[]
}

const DAY_MS = 86_400_000

/** `YYYY-MM-DD` for a UTC date. Every date in this product is a plain day, never an instant. */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function parseDay(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00.000Z`)
}

export function addDays(iso: string, days: number): string {
  return isoDay(new Date(parseDay(iso).getTime() + days * DAY_MS))
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / DAY_MS)
}

/** The first of the month a date falls in. */
export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`
}

export function addMonths(iso: string, months: number): string {
  const date = parseDay(startOfMonth(iso))
  date.setUTCMonth(date.getUTCMonth() + months)
  return isoDay(date)
}

export function positionOf(date: string, today: string): DayPosition {
  if (date < today) return 'past'
  if (date === today) return 'today'
  return 'future'
}

/**
 * Whether a day can take a topic that was not already there — by a drag, or by
 * the merchant adding one.
 *
 * Today cannot, and that is deliberate rather than an off-by-one. The day's
 * generation pass may already have run and taken its one topic; dropping
 * something onto today would either do nothing or produce a second article on a
 * day that has had its one. Both are the surprise the calendar exists to
 * prevent. A gap that has arrived is a gap.
 */
export function acceptsTopic(date: string, today: string): boolean {
  return positionOf(date, today) === 'future'
}

/** Builds the month a merchant is looking at, weeks starting Monday. */
export function monthGrid(
  month: string,
  topics: readonly CalendarTopic[],
  today: string,
): MonthGrid {
  const first = startOfMonth(month)
  const byDate = new Map<string, CalendarTopic>()
  for (const topic of topics) {
    // At most one topic occupies a day. If the API ever sends two, the earlier
    // one wins rather than the later silently replacing it, so the disagreement
    // is visible in the response instead of being hidden by render order.
    if (!byDate.has(topic.scheduledFor)) byDate.set(topic.scheduledFor, topic)
  }

  const firstDate = parseDay(first)
  const monthKey = first.slice(0, 7)
  // getUTCDay() counts from Sunday; the grid starts on Monday.
  const lead = (firstDate.getUTCDay() + 6) % 7
  const gridStart = addDays(first, -lead)

  const weeks: CalendarDay[][] = []
  const days: CalendarDay[] = []
  let cursor = gridStart

  // Six rows always: a month that needs five would otherwise change height as
  // the merchant pages through, and the grid would jump under the pointer.
  for (let week = 0; week < 6; week += 1) {
    const row: CalendarDay[] = []
    for (let index = 0; index < 7; index += 1) {
      const inMonth = cursor.slice(0, 7) === monthKey
      const topic = byDate.get(cursor) ?? null
      const position = positionOf(cursor, today)
      const day: CalendarDay = {
        date: cursor,
        inMonth,
        position,
        topic,
        emptyTreatment: topic ? 'none' : position === 'future' ? 'open' : 'blank',
      }
      row.push(day)
      if (inMonth) days.push(day)
      cursor = addDays(cursor, 1)
    }
    weeks.push(row)
  }

  return { month: first, weeks, days }
}

// ── What a chip says ────────────────────────────────────────────────────────

/**
 * The label on a topic chip. Past days carry outcomes and future days carry
 * plans, so one state can read two ways — `published` is an outcome, `planned`
 * is an intention — and the key is chosen by state alone because the state is
 * what the server actually knows.
 */
export function topicStateKey(state: TopicState): StringKey {
  return `content.topicState.${state}` as StringKey
}

export function topicStateLabel(state: TopicState, t: Translate = defaultTranslate): string {
  return t(topicStateKey(state))
}

/** `new` / `refresh`, shown next to the state so a refresh is never mistaken for a new page. */
export function topicKindLabel(kind: 'new' | 'refresh', t: Translate = defaultTranslate): string {
  return t(`content.topicKind.${kind}` as StringKey)
}

export function intentLabel(intentClass: string, t: Translate = defaultTranslate): string {
  try {
    return t(`content.intent.${intentClass}` as StringKey)
  } catch {
    return intentClass
  }
}

export function topicSourceLabel(source: string, t: Translate = defaultTranslate): string {
  try {
    return t(`content.source.${source}` as StringKey)
  } catch {
    return source
  }
}

export function gateLabel(gate: string, t: Translate = defaultTranslate): string {
  try {
    return t(`content.gate.${gate}` as StringKey)
  } catch {
    return gate
  }
}

/**
 * Which of the two vetoes a topic gets.
 *
 * Up until the generation job takes it, removing a topic is free and instant.
 * After that the draft has already been paid for, so the action stops being a
 * removal and becomes a decision not to publish what was written — a different
 * sentence, and a confirmation, because it discards something that exists.
 */
export type VetoKind = 'remove' | 'cancel_publication' | 'unavailable'

export function vetoKind(topic: CalendarTopic): VetoKind {
  if (topic.state === 'planned' || topic.state === 'checking') return 'remove'
  if (topic.state === 'generating' || topic.state === 'in_review') return 'cancel_publication'
  return 'unavailable'
}

// ── Dragging ────────────────────────────────────────────────────────────────

export type MoveRefusal = 'pinned' | 'occupant_pinned' | 'not_movable' | 'date_in_past' | 'same_day'

export type MoveOutcome =
  | { readonly ok: true; readonly swap: boolean }
  | { readonly ok: false; readonly reason: MoveRefusal }

/**
 * Whether a topic may be dragged onto a day, worked out before anything is
 * sent, so a refusal is instant and explains itself.
 *
 * A pin is a promise the merchant made to themselves — this goes out on this
 * day — so it survives both ends of a drag: a pinned topic does not move, and a
 * pinned topic is not displaced by something dropped on top of it. Dropping on
 * an occupied day swaps the two rather than stacking them, because the day
 * holds one topic and something has to leave.
 */
export function moveOutcome(
  topic: CalendarTopic,
  toDate: string,
  occupant: CalendarTopic | null,
  today: string,
): MoveOutcome {
  if (toDate === topic.scheduledFor) return { ok: false, reason: 'same_day' }
  if (topic.pinned) return { ok: false, reason: 'pinned' }
  if (vetoKind(topic) !== 'remove') return { ok: false, reason: 'not_movable' }
  if (!acceptsTopic(toDate, today)) return { ok: false, reason: 'date_in_past' }
  if (occupant) {
    if (occupant.pinned) return { ok: false, reason: 'occupant_pinned' }
    // The topic being displaced has to be able to go where this one came from.
    if (vetoKind(occupant) !== 'remove') return { ok: false, reason: 'not_movable' }
    if (!acceptsTopic(topic.scheduledFor, today)) return { ok: false, reason: 'date_in_past' }
    return { ok: true, swap: true }
  }
  return { ok: true, swap: false }
}

export function moveRefusalKey(reason: MoveRefusal): StringKey {
  return `content.moveRefused.${reason}` as StringKey
}

// ── The legend ──────────────────────────────────────────────────────────────

/**
 * The key at the top of the grid. The last row is the one that matters most: it
 * is where a merchant learns that an empty day is a normal outcome rather than
 * a missed one, which is the single thing about this screen most likely to be
 * misread.
 */
export const CALENDAR_LEGEND = [
  { id: 'published', key: 'content.legend.published' },
  { id: 'in_review', key: 'content.legend.inReview' },
  { id: 'rejected_by_gate', key: 'content.legend.held' },
  { id: 'generating', key: 'content.legend.generating' },
  { id: 'planned', key: 'content.legend.planned' },
  { id: 'vetoed', key: 'content.legend.vetoed' },
  { id: 'open', key: 'content.legend.openDay' },
] as const satisfies readonly { id: string; key: StringKey }[]

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatMonth(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parseDay(iso))
}

export function formatDayNumber(iso: string): string {
  return String(parseDay(iso).getUTCDate())
}

/** Mon…Sun, for the column headings. */
export const WEEKDAY_KEYS = [
  'content.weekday.mon',
  'content.weekday.tue',
  'content.weekday.wed',
  'content.weekday.thu',
  'content.weekday.fri',
  'content.weekday.sat',
  'content.weekday.sun',
] as const satisfies readonly StringKey[]

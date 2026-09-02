import { t as defaultTranslate, type StringKey, type Translate } from '../strings'
import type { PostOutcome } from '../opportunities/actions'
import { formatDate } from '../opportunities/list'
import { moveOutcome, moveRefusalKey, type MoveOutcome } from './calendar'
import type { AddTopicResponse, CalendarResponse, CalendarTopic } from './types'

/**
 * What happens when a merchant vetoes, drags, pins or adds a topic — and what
 * they are told afterwards.
 *
 * Two things put this in its own file rather than inside the grid. Every one of
 * these requests can come back refused: the daily job takes a topic the moment
 * its date arrives, so a topic can start generating underneath a merchant who
 * has had the calendar open since breakfast, and a refused move has to end in a
 * re-read and a sentence rather than a button that silently did nothing. And
 * the veto's undo is the product's promise that nothing is irreversible until
 * it is, which is not a promise anyone can check by looking at a toast.
 *
 * **The veto is held rather than sent and taken back.** Everything else here
 * fires immediately, but there is no route that un-vetoes a topic — vetoed
 * topics go on a list replenishment consults, so reviving one is not a thing
 * the API can do. So the undo window is real time: the request waits out the
 * five seconds the toast is up, and pressing Undo cancels a request that was
 * never sent. Leaving the page early sends it at once rather than dropping it.
 */

export interface CalendarApi {
  load(from: string, to: string): Promise<CalendarResponse | null>
  /** Paths are relative to `/api/calendar`. */
  post(path: string, body?: unknown): Promise<PostOutcome>
  /**
   * Paths are relative to `/api/opportunities`. Vetoing a topic also dismisses
   * the opportunity that produced it, and that is a different endpoint.
   */
  opportunityPost(path: string, body?: unknown): Promise<PostOutcome>
}

export interface CalendarToast {
  readonly id: string
  readonly message: string
  readonly undoLabel?: string
  readonly onUndo?: () => void
}

export interface CalendarSurface {
  toast(toast: CalendarToast): void
  /** Something moved under us: read the range again rather than patching what we think we know. */
  refresh(): void
  /** Held out of the grid while its undo is still on offer. */
  setHidden(topicId: string, hidden: boolean): void
  setBusy(topicId: string, busy: boolean): void
  /** A refused drop shakes the day it was dropped on and says why. */
  refuse(date: string, message: string): void
}

/**
 * The sentence for a refused transition. Every one of these ends in a re-read,
 * so the message says what happened rather than offering a retry that would
 * race exactly the same way.
 */
export function calendarConflictMessage(code: string | null, t: Translate = defaultTranslate): string {
  const keys: Record<string, StringKey> = {
    topic_already_published: 'content.toast.alreadyPublished',
    topic_already_generating: 'content.toast.alreadyGenerating',
    topic_pinned: 'content.moveRefused.pinned',
    calendar_day_occupied: 'content.toast.dayOccupied',
    calendar_date_in_past: 'content.toast.dateInPast',
  }
  if (code === null) return t('content.toast.failed')
  return t(keys[code] ?? 'content.toast.conflict')
}

let counter = 0
function toastId(): string {
  counter += 1
  return `content-toast-${counter}`
}

export interface CalendarActions {
  /**
   * Removes a topic, and the opportunity behind it, after the undo window
   * closes. Returns once the window has closed and the requests have run — or
   * immediately, if the merchant undid it.
   */
  veto(topic: CalendarTopic): Promise<void>
  move(topic: CalendarTopic, toDate: string, occupant: CalendarTopic | null, today: string): Promise<void>
  pin(topic: CalendarTopic, pinned: boolean): Promise<void>
  add(input: { title: string; date: string; pin: boolean }): Promise<AddTopicResponse | null>
  /** Sends anything still waiting out its undo window. Called when the screen goes away. */
  flush(): Promise<void>
}

export interface CalendarActionOptions {
  /** How long an undo stays on offer. */
  readonly undoMs?: number
  readonly t?: Translate
}

export function createCalendarActions(
  api: CalendarApi,
  surface: CalendarSurface,
  options: CalendarActionOptions = {},
): CalendarActions {
  const t = options.t ?? defaultTranslate
  const undoMs = options.undoMs ?? 5000
  /** Vetoes whose undo window has not closed yet, by topic id. */
  const pending = new Map<string, { send: () => Promise<void>; cancel: () => void }>()

  async function run(topic: CalendarTopic, path: string, body?: unknown): Promise<PostOutcome> {
    surface.setBusy(topic.id, true)
    try {
      const outcome = await api.post(path, body)
      if (!outcome.ok) {
        surface.toast({ id: toastId(), message: calendarConflictMessage(outcome.conflict, t) })
        surface.refresh()
      }
      return outcome
    } finally {
      surface.setBusy(topic.id, false)
    }
  }

  return {
    async veto(topic) {
      surface.setHidden(topic.id, true)

      let cancelled = false
      let settle: () => void = () => {}
      const closed = new Promise<void>((resolve) => {
        settle = resolve
      })

      const send = async () => {
        pending.delete(topic.id)
        if (cancelled) return
        const outcome = await api.post(`/topics/${topic.id}/veto`)
        if (!outcome.ok) {
          // The topic is still there; put it back and say what happened.
          surface.setHidden(topic.id, false)
          surface.toast({ id: toastId(), message: calendarConflictMessage(outcome.conflict, t) })
          surface.refresh()
          return
        }
        // The topic and the opportunity that produced it are one decision, so
        // the second request follows the first without asking again. A refusal
        // here is not worth a second sentence: the opportunity is already gone
        // or already acted on, and the topic — the thing on screen — went.
        if (topic.opportunityId) {
          await api.opportunityPost(`/${topic.opportunityId}/dismiss`)
        }
        surface.refresh()
      }

      const timer = setTimeout(() => {
        void send().finally(settle)
      }, undoMs)

      pending.set(topic.id, {
        send: async () => {
          clearTimeout(timer)
          await send()
          settle()
        },
        cancel: () => {
          clearTimeout(timer)
          cancelled = true
          pending.delete(topic.id)
          settle()
        },
      })

      surface.toast({
        id: toastId(),
        message: t('content.toast.vetoed'),
        undoLabel: t('content.toast.undo'),
        onUndo: () => {
          pending.get(topic.id)?.cancel()
          surface.setHidden(topic.id, false)
          surface.toast({ id: toastId(), message: t('content.toast.restored') })
        },
      })

      await closed
    },

    async move(topic, toDate, occupant, today) {
      const decision: MoveOutcome = moveOutcome(topic, toDate, occupant, today)
      if (!decision.ok) {
        // Refused before anything is sent: the rules are the same ones the
        // server enforces, and a drop that cannot work should say so the
        // instant it lands rather than after a round trip.
        surface.refuse(toDate, t(moveRefusalKey(decision.reason)))
        return
      }

      const from = topic.scheduledFor
      if (!(await run(topic, `/topics/${topic.id}/move`, { date: toDate })).ok) return

      if (decision.swap && occupant) {
        // Two writes, not one: the contract has no swap. If the second is
        // refused the first stands, so the calendar is re-read and the merchant
        // sees where things actually are rather than where we assumed.
        if (!(await run(occupant, `/topics/${occupant.id}/move`, { date: from })).ok) return
        surface.toast({ id: toastId(), message: t('content.toast.swapped', { date: formatDate(from) }) })
      } else {
        surface.toast({ id: toastId(), message: t('content.toast.moved', { date: formatDate(toDate) }) })
      }
      surface.refresh()
    },

    async pin(topic, pinned) {
      if (!(await run(topic, `/topics/${topic.id}/pin`, { pinned })).ok) return
      surface.toast({
        id: toastId(),
        message: pinned
          ? t('content.toast.pinned', { date: formatDate(topic.scheduledFor) })
          : t('content.toast.unpinned'),
      })
      surface.refresh()
    },

    async add(input) {
      const outcome = await api.post('/topics', {
        title: input.title,
        date: input.date,
        pin: input.pin,
      })
      if (!outcome.ok) {
        surface.toast({ id: toastId(), message: calendarConflictMessage(outcome.conflict, t) })
        surface.refresh()
        return null
      }
      surface.refresh()
      return outcome.body as AddTopicResponse
    },

    async flush() {
      const waiting = [...pending.values()]
      pending.clear()
      await Promise.all(waiting.map((entry) => entry.send()))
    },
  }
}

/** The calendar and opportunity routes, over the app's own API. */
export function httpCalendarApi(fetchImpl: typeof fetch = fetch): CalendarApi {
  async function post(base: string, path: string, body?: unknown): Promise<PostOutcome> {
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      if (response.ok) return { ok: true, body: await response.json().catch(() => undefined) }
      const payload = (await response.json().catch(() => null)) as { error?: { code?: string } } | null
      return { ok: false, conflict: payload?.error?.code ?? null }
    } catch {
      return { ok: false, conflict: null }
    }
  }

  return {
    async load(from, to) {
      try {
        const response = await fetchImpl(`/api/calendar?from=${from}&to=${to}`, {
          headers: { accept: 'application/json' },
        })
        if (!response.ok) return null
        return (await response.json()) as CalendarResponse
      } catch {
        return null
      }
    },
    post: (path, body) => post('/api/calendar', path, body),
    opportunityPost: (path, body) => post('/api/opportunities', path, body),
  }
}

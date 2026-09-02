'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useUiAnalytics } from '../analytics'
import { t as defaultTranslate, type Translate } from '../strings'
import { formatDate } from '../opportunities/list'
import { AddTopicForm } from './AddTopicForm'
import { TopicChip } from './TopicChip'
import { TopicPopover } from './TopicPopover'
import {
  CALENDAR_LEGEND,
  WEEKDAY_KEYS,
  addMonths,
  daysBetween,
  formatDayNumber,
  formatMonth,
  monthGrid,
  startOfMonth,
  vetoKind,
  type CalendarDay,
} from './calendar'
import {
  createCalendarActions,
  httpCalendarApi,
  type CalendarApi,
  type CalendarToast,
} from './actions'
import type { CalendarResponse, CalendarTopic } from './types'

/**
 * The content calendar: what is planned, what happened, and what a merchant can
 * change about either.
 *
 * The screen's hardest job is not the dragging. It is making an empty day
 * legible. We write at most one article a day and never make a quiet day up
 * afterwards, so a month with gaps in it is the product working correctly — and
 * a calendar that renders a gap as a hole, offers to fill it, or counts it
 * against anything would be telling the merchant the opposite. So the two kinds
 * of empty day look different on purpose: a future day is an opening and says
 * what will happen to it, and a day that has passed with nothing on it renders
 * as nothing at all, with the legend carrying the one sentence explaining why.
 *
 * What is reported is thin by design: which topic, how far ahead it sat, how
 * far it moved. Never its title, never its why-line — both are the merchant's
 * own store described back to them, and the event table has no property that
 * could hold either.
 */

const UNDO_MS = 5000
/** How long a refused drop shakes for. */
const SHAKE_MS = 700

export interface CalendarScreenProps {
  readonly initialData: CalendarResponse
  /** `YYYY-MM-DD` in the merchant's own reckoning, decided on the server. */
  readonly today: string
  readonly t?: Translate
  /** Swapped for a double in tests; the default talks to `/api/calendar`. */
  readonly api?: CalendarApi
  readonly opportunitiesHref?: string
  readonly toastMs?: number
}

export function CalendarScreen({
  initialData,
  today,
  t = defaultTranslate,
  api,
  opportunitiesHref = '/opportunities',
  toastMs = UNDO_MS,
}: CalendarScreenProps) {
  const analytics = useUiAnalytics()
  const [data, setData] = useState(initialData)
  const [month, setMonth] = useState(() => startOfMonth(today))
  const [view, setView] = useState<'month' | 'week'>('month')
  const [hidden, setHidden] = useState<readonly string[]>([])
  const [busy, setBusy] = useState<readonly string[]>([])
  const [toasts, setToasts] = useState<readonly CalendarToast[]>([])
  const [open, setOpen] = useState<CalendarTopic | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<CalendarTopic | null>(null)
  const [dragging, setDragging] = useState<CalendarTopic | null>(null)
  const [shake, setShake] = useState<{ date: string; message: string } | null>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  const client = useMemo(() => api ?? httpCalendarApi(), [api])

  const visible = useMemo(
    () => data.topics.filter((topic) => !hidden.includes(topic.id)),
    [data.topics, hidden],
  )
  const grid = useMemo(() => monthGrid(month, visible, today), [month, visible, today])

  function dropToast(id: string) {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }

  const actions = useMemo(
    () =>
      createCalendarActions(
        client,
        {
          toast(toast) {
            setToasts((current) => [...current, toast])
            timers.current.push(setTimeout(() => dropToast(toast.id), toastMs))
          },
          refresh() {
            // A read that failed is not news: what is on screen is still the
            // last thing the server actually said.
            void client.load(grid.weeks[0]![0]!.date, grid.weeks[5]![6]!.date).then((next) => {
              if (next) {
                setData(next)
                setHidden([])
              }
            })
          },
          setHidden(id, isHidden) {
            setHidden((current) =>
              isHidden ? [...current, id] : current.filter((entry) => entry !== id),
            )
          },
          setBusy(id, isBusy) {
            setBusy((current) => (isBusy ? [...current, id] : current.filter((entry) => entry !== id)))
          },
          refuse(date, message) {
            setShake({ date, message })
            timers.current.push(setTimeout(() => setShake(null), SHAKE_MS))
          },
        },
        { undoMs: toastMs, t },
      ),
    [client, grid, t, toastMs],
  )

  const actionsRef = useRef(actions)
  actionsRef.current = actions

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending) clearTimeout(timer)
      // A veto waiting out its undo window when the merchant leaves is sent
      // rather than dropped: they pressed the button, and only Undo takes it
      // back.
      void actionsRef.current.flush()
    }
  }, [])

  function startVeto(topic: CalendarTopic) {
    analytics.capture('topic_veto_clicked', {
      topic_id: topic.id,
      days_ahead: daysBetween(today, topic.scheduledFor),
    })
    setOpen(null)
    void actions.veto(topic)
  }

  function onVeto(topic: CalendarTopic) {
    // A topic already being written is a different decision: the draft exists,
    // so the merchant is asked before it is thrown away.
    if (vetoKind(topic) === 'cancel_publication') {
      setConfirming(topic)
      return
    }
    startVeto(topic)
  }

  function onDrop(day: CalendarDay) {
    const topic = dragging
    setDragging(null)
    if (!topic) return
    const moved = daysBetween(topic.scheduledFor, day.date)
    analytics.capture('calendar_topic_dragged', {
      topic_id: topic.id,
      days_moved: moved,
      swapped: day.topic !== null,
    })
    setOpen(null)
    void actions.move(topic, day.date, day.topic, today)
  }

  const nothingPlanned = data.topics.length === 0

  return (
    <section className="sortiva-calendar" data-calendar-view={view}>
      <header className="sortiva-calendar__head">
        <div>
          <h1 className="sortiva-calendar__heading">{t('content.calendar.heading')}</h1>
          <p className="sortiva-calendar__intro">{t('content.calendar.intro')}</p>
          {data.nextReplenishmentAt ? (
            <p className="sortiva-calendar__horizon" data-next-replenishment={data.nextReplenishmentAt}>
              {t('content.calendar.plannedThrough', { date: formatDate(data.nextReplenishmentAt) })}
            </p>
          ) : null}
        </div>
        <div className="sortiva-calendar__views">
          <button
            type="button"
            data-calendar-view-button="month"
            aria-pressed={view === 'month'}
            onClick={() => setView('month')}
          >
            {t('content.view.month')}
          </button>
          <button
            type="button"
            data-calendar-view-button="week"
            aria-pressed={view === 'week'}
            onClick={() => setView('week')}
          >
            {t('content.view.week')}
          </button>
        </div>
      </header>

      {data.paused.active ? (
        <p className="sortiva-calendar__paused" role="status" data-calendar-paused={data.paused.reason ?? 'paused'}>
          {t('content.calendar.paused')}
        </p>
      ) : null}

      <ul className="sortiva-calendar__legend" aria-label={t('content.legend.label')}>
        {CALENDAR_LEGEND.map((entry) => (
          <li key={entry.id} data-legend={entry.id}>
            <span className="sortiva-calendar__swatch" data-legend-swatch={entry.id} aria-hidden="true" />
            {t(entry.key)}
          </li>
        ))}
      </ul>
      {/* The sentence that makes the one-a-day ceiling legible rather than
          merely obeyed: a blank day that has passed is a normal outcome. */}
      <p className="sortiva-calendar__gap-note" data-gap-note>
        {t('content.legend.gapNote')}
      </p>

      {nothingPlanned ? (
        <div className="sortiva-calendar__empty" data-calendar-empty>
          <p>{t('content.calendar.empty')}</p>
          <a href={opportunitiesHref}>{t('content.calendar.emptyLink')}</a>
        </div>
      ) : (
        <>
          <div className="sortiva-calendar__month">
            <button
              type="button"
              data-calendar-month="previous"
              onClick={() => setMonth(addMonths(month, -1))}
            >
              {t('content.calendar.previousMonth')}
            </button>
            <h2 data-calendar-month-label>{formatMonth(month)}</h2>
            <button type="button" data-calendar-month="next" onClick={() => setMonth(addMonths(month, 1))}>
              {t('content.calendar.nextMonth')}
            </button>
          </div>

          {view === 'month' ? (
            <div className="sortiva-calendar__grid" role="grid" aria-label={t('content.calendar.gridLabel')}>
              <div className="sortiva-calendar__weekdays" role="row">
                {WEEKDAY_KEYS.map((key) => (
                  <span key={key} role="columnheader">
                    {t(key)}
                  </span>
                ))}
              </div>
              {grid.weeks.map((week) => (
                <div className="sortiva-calendar__week" role="row" key={week[0]!.date}>
                  {week.map((day) => renderDay(day))}
                </div>
              ))}
            </div>
          ) : (
            <ol className="sortiva-calendar__list">
              {grid.days
                .filter((day) => day.topic !== null || day.emptyTreatment === 'open')
                .map((day) => (
                  <li key={day.date} data-calendar-row={day.date}>
                    <span className="sortiva-calendar__list-date">{formatDate(day.date)}</span>
                    {renderDayBody(day)}
                  </li>
                ))}
            </ol>
          )}
        </>
      )}

      {open ? (
        <TopicPopover
          topic={open}
          t={t}
          busy={busy.includes(open.id)}
          opportunityHref={opportunitiesHref}
          onClose={() => setOpen(null)}
          onVeto={onVeto}
          onPin={(topic, pinned) => {
            setOpen(null)
            void actions.pin(topic, pinned)
          }}
        />
      ) : null}

      {adding ? (
        <AddTopicForm
          date={adding}
          t={t}
          opportunityHref={opportunitiesHref}
          onSubmit={(input) => actions.add(input)}
          onClose={() => setAdding(null)}
        />
      ) : null}

      {confirming ? (
        <div className="sortiva-confirm" role="dialog" aria-label={t('content.veto.confirmTitle')} data-confirm="veto">
          <h3>{t('content.veto.confirmTitle')}</h3>
          <p>{t('content.veto.confirmBody')}</p>
          <div className="sortiva-confirm__actions">
            <button type="button" data-confirm-action="keep" onClick={() => setConfirming(null)}>
              {t('content.veto.confirmKeep')}
            </button>
            <button
              type="button"
              className="sortiva-content-button sortiva-content-button--destructive"
              data-confirm-action="discard"
              onClick={() => {
                const topic = confirming
                setConfirming(null)
                startVeto(topic)
              }}
            >
              {t('content.veto.confirmDiscard')}
            </button>
          </div>
        </div>
      ) : null}

      {toasts.length > 0 ? (
        <div className="sortiva-opps__toasts" role="status" aria-label={t('content.toastLabel')}>
          {toasts.map((toast) => (
            <div key={toast.id} className="sortiva-toast" data-toast={toast.id}>
              <span>{toast.message}</span>
              {toast.undoLabel ? (
                <button
                  type="button"
                  className="sortiva-toast__action"
                  data-toast-undo
                  onClick={() => {
                    toast.onUndo?.()
                    dropToast(toast.id)
                  }}
                >
                  {toast.undoLabel}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )

  function renderDay(day: CalendarDay) {
    const refused = shake?.date === day.date
    return (
      <div
        className="sortiva-calendar__day"
        role="gridcell"
        key={day.date}
        data-day={day.date}
        data-day-position={day.position}
        data-day-in-month={day.inMonth ? 'true' : 'false'}
        data-day-empty={day.emptyTreatment}
        data-day-refused={refused ? 'true' : 'false'}
        onDragOver={(event) => {
          if (dragging) event.preventDefault()
        }}
        onDrop={(event) => {
          event.preventDefault()
          onDrop(day)
        }}
      >
        <span className="sortiva-calendar__daynum" aria-hidden={!day.inMonth}>
          {formatDayNumber(day.date)}
        </span>
        {renderDayBody(day)}
        {refused ? (
          <p className="sortiva-calendar__refusal" role="alert" data-day-refusal>
            {shake.message}
          </p>
        ) : null}
      </div>
    )
  }

  function renderDayBody(day: CalendarDay) {
    if (day.topic) {
      return (
        <TopicChip
          topic={day.topic}
          t={t}
          busy={busy.includes(day.topic.id)}
          draggable={vetoKind(day.topic) === 'remove' && !day.topic.pinned}
          opportunityHref={opportunitiesHref}
          onOpen={setOpen}
          onDragStart={setDragging}
          onDragEnd={() => setDragging(null)}
        />
      )
    }

    // A day that has passed with nothing on it renders nothing: there was no
    // article because none was scheduled, and marking it would invent a
    // shortfall the product does not have.
    if (day.emptyTreatment !== 'open') return null

    return (
      <button
        type="button"
        className="sortiva-calendar__add"
        data-day-add={day.date}
        title={t('content.day.openDayHint')}
        aria-label={t('content.day.addOn', { date: formatDate(day.date) })}
        onClick={() => setAdding(day.date)}
      >
        <span aria-hidden="true">+</span>
      </button>
    )
  }
}

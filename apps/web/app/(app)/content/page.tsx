import { CalendarScreen, type CalendarResponse } from '@sortiva/ui'
import '@sortiva/ui/styles/opportunities.css'
import '@sortiva/ui/styles/content.css'
import { getJson, requestContext } from '../_lib/api'
import { ContentTabs } from './_lib/nav'

/**
 * The content calendar — what is planned, what happened, and what the merchant
 * can change about either.
 *
 * The month around today is read on the server so the grid is drawn in the
 * first frame; everything after that (opening a topic, vetoing one, dragging
 * one, adding one) is a conversation with the browser and happens in the
 * screen.
 *
 * "Today" is decided here rather than in the browser. The screen has to know
 * which days are past — the whole distinction between an outcome and a plan
 * rests on it — and a browser clock is the merchant's laptop, which may be set
 * to anything. This is still not the right answer: the day that matters is the
 * one in the store audience's timezone, which the settings response knows and
 * this does not yet ask for. Recorded in DECISIONS; the correction is one read.
 *
 * A read that failed renders an empty calendar rather than an error page: an
 * empty calendar says "your plan is being built", which is true often enough to
 * be a better thing to see than a failure.
 */

export const dynamic = 'force-dynamic'

const EMPTY: CalendarResponse = {
  topics: [],
  paused: { active: false, reason: null },
  nextReplenishmentAt: null,
}

/** Six weeks either side of the month in view, which is what the grid can show. */
function range(today: string): { from: string; to: string } {
  const first = new Date(`${today.slice(0, 7)}-01T00:00:00.000Z`)
  const from = new Date(first)
  from.setUTCDate(from.getUTCDate() - 7)
  const to = new Date(first)
  to.setUTCMonth(to.getUTCMonth() + 1)
  to.setUTCDate(to.getUTCDate() + 7)
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
}

export default async function ContentCalendarPage() {
  const today = new Date().toISOString().slice(0, 10)
  const { from, to } = range(today)
  const data =
    (await getJson<CalendarResponse>(`/api/calendar?from=${from}&to=${to}`, await requestContext())) ??
    EMPTY

  return (
    <>
      <ContentTabs current="calendar" />
      <CalendarScreen initialData={data} today={today} />
    </>
  )
}

import { withAccount } from '../auth/_lib/session'
import { calendarDeps } from './_lib/config'
import { makeGetCalendarHandler } from './_lib/handlers'

/**
 * `GET /api/calendar` — the queue and the calendar are the same object,
 * viewed by date (main §8.7). Read-only: every mutation has its own route
 * under `/api/calendar/topics`.
 */
export const dynamic = 'force-dynamic'

export const GET = withAccount(makeGetCalendarHandler(calendarDeps()))

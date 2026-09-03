import { withAccount } from '../auth/_lib/session'
import { calendarDeps } from './_lib/config'
import { makeGetCalendarHandler } from './_lib/handlers'

/**
 * `GET /api/calendar` — the queue and the calendar are the same object,
 * viewed by date (main §8.7). Read-only: every mutation has its own route
 * under `/api/calendar/topics`.
 */
export const dynamic = 'force-dynamic'

// `calendarDeps()` is called inside the handler, not passed at module scope —
// it resolves `db()`, which opens a real connection pool, and Next's build-time
// "collect page data" step evaluates every route module without DATABASE_URL
// necessarily available. Calling it eagerly here broke `pnpm build` with
// "DATABASE_URL is not set"; deferring it to request time (matching the lazy
// `database()` closure `packages/db/src/stores/keywords.ts`'s composition
// already uses for the same reason) fixes it without changing behaviour —
// `db()` itself is still memoized, so this costs nothing per request.
export const GET = withAccount((request, context) => makeGetCalendarHandler(calendarDeps())(request, context))

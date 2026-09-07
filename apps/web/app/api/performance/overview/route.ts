import { withAccount } from '../../auth/_lib/session'
import { performanceDeps } from '../_lib/config'
import { makePerformanceOverviewHandler } from '../_lib/handlers'

/** `GET /api/performance/overview` — the chart, its markers and the results table. */
export const dynamic = 'force-dynamic'

// `performanceDeps()` deferred to request time — see the note in
// `apps/web/app/api/performance/_lib/config.ts`.
export const GET = withAccount((request, context) =>
  makePerformanceOverviewHandler(performanceDeps())(request, context),
)

import { withAccount } from '../../auth/_lib/session'
import { performanceDeps } from '../_lib/config'
import { makeSearchConsoleHandler } from '../_lib/handlers'

/** `GET /api/performance/search-console` — the query and page tables, with signal badges. */
export const dynamic = 'force-dynamic'

// `performanceDeps()` deferred to request time — see the note in
// `apps/web/app/api/performance/_lib/config.ts`.
export const GET = withAccount((request, context) =>
  makeSearchConsoleHandler(performanceDeps())(request, context),
)

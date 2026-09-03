import { withAccount } from '../auth/_lib/session'
import { opportunitiesDeps } from './_lib/config'
import { makeListOpportunitiesHandler } from './_lib/handlers'

/** `GET /api/opportunities` — ui spec §5.1. */
export const dynamic = 'force-dynamic'

// `opportunitiesDeps()` deferred to request time — see the identical note in
// `apps/web/app/api/calendar/route.ts` (the build failure that pattern fixes).
export const GET = withAccount((request, context) => makeListOpportunitiesHandler(opportunitiesDeps())(request, context))

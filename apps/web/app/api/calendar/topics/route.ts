import { withAccount } from '../../auth/_lib/session'
import { addTopicDeps } from './_lib/config'
import { makeAddTopicHandler } from './_lib/add'

/**
 * `POST /api/calendar/topics` — add a topic by hand, main §8.7. Still passes
 * Gate 1, may convert to an OPTIMIZE, and — since the founder's decision of
 * 2026-09-03 (relayed mid-card; DECISIONS 2026-09-03 T4.2) — the merchant's
 * typed title is turned into a search cluster by one model call first.
 */
export const dynamic = 'force-dynamic'

// `addTopicDeps()` deferred to request time, not called at module scope —
// see the identical note in `apps/web/app/api/calendar/route.ts`. It resolves
// `db()` (and the LLM client), which broke `pnpm build`'s page-data
// collection when called eagerly here.
export const POST = withAccount((request, context) => makeAddTopicHandler(addTopicDeps())(request, context))

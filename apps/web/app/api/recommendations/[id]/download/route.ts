import { withAccount } from '../../../auth/_lib/session'
import { recommendationsDeps } from '../../_lib/config'
import { makeDownloadRecommendationHandler, type RecommendationRouteCtx } from '../../_lib/handlers'

/** `GET /api/recommendations/{id}/download?format=md|html` — main §10.4's take-away. */
export const dynamic = 'force-dynamic'

// Built inside the closure, not at module scope — see the note in the parent route.
export const GET = withAccount<RecommendationRouteCtx>((request, context) =>
  makeDownloadRecommendationHandler(recommendationsDeps())(request, context),
)

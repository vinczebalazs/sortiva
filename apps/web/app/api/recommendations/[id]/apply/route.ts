import { withAccount } from '../../../auth/_lib/session'
import { recommendationsDeps } from '../../_lib/config'
import { makeApplyRecommendationHandler, type RecommendationRouteCtx } from '../../_lib/handlers'

/** `POST /api/recommendations/{id}/apply` — "Mark as applied", per task or whole (main §10.4). */
export const dynamic = 'force-dynamic'

// Built inside the closure, not at module scope — see the note in the parent route.
export const POST = withAccount<RecommendationRouteCtx>((request, context) =>
  makeApplyRecommendationHandler(recommendationsDeps())(request, context),
)

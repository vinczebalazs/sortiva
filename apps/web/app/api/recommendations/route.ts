import { withAccount } from '../auth/_lib/session'
import { recommendationsDeps } from './_lib/config'
import { makeGenerateRecommendationHandler, makeReadRecommendationHandler } from './_lib/handlers'

/** `/api/recommendations` — ask for a page's recommendations, and read them back (ui §5.3). */
export const dynamic = 'force-dynamic'

// `recommendationsDeps()` is called inside the closure, at request time. At
// module scope it runs during the production build, where there is no database
// URL — every route then answers 500 while `pnpm build` stays green. See the
// identical note in `apps/web/app/api/calendar/route.ts`.
export const POST = withAccount((request, context) =>
  makeGenerateRecommendationHandler(recommendationsDeps())(request, context),
)

export const GET = withAccount((request, context) =>
  makeReadRecommendationHandler(recommendationsDeps())(request, context),
)

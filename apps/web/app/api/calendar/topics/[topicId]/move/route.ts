import { withAccount, type AccountContext } from '../../../../auth/_lib/session'
import { topicMutationDeps } from '../../_lib/config'
import { makeMoveTopicHandler, type RouteCtx } from '../../_lib/mutations'

/** `POST /api/calendar/topics/{topicId}/move` — drag a planned topic to another future date; swaps with an unpinned occupant. */
export const dynamic = 'force-dynamic'

// `topicMutationDeps()` deferred to request time — see the identical note in
// `apps/web/app/api/calendar/route.ts`.
export const POST = withAccount((request, context: AccountContext<RouteCtx>) =>
  makeMoveTopicHandler(topicMutationDeps())(request, context),
)

import { withAccount, type AccountContext } from '../../../../auth/_lib/session'
import { topicMutationDeps } from '../../_lib/config'
import { makePinTopicHandler, type RouteCtx } from '../../_lib/mutations'

/** `POST /api/calendar/topics/{topicId}/pin` — pin or unpin; replenishment and reordering never move a pinned topic. */
export const dynamic = 'force-dynamic'

// `topicMutationDeps()` deferred to request time — see the identical note in
// `apps/web/app/api/calendar/route.ts`.
export const POST = withAccount((request, context: AccountContext<RouteCtx>) =>
  makePinTopicHandler(topicMutationDeps())(request, context),
)

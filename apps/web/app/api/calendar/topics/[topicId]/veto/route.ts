import { withAccount, type AccountContext } from '../../../../auth/_lib/session'
import { topicMutationDeps } from '../../_lib/config'
import { makeVetoTopicHandler, type RouteCtx } from '../../_lib/mutations'

/**
 * `POST /api/calendar/topics/{topicId}/veto` — free and instant on a
 * `planned` topic; cancels publication (draft discarded, cost absorbed) on a
 * `generating`/`in_review` one. Main §8.7's lock semantics.
 */
export const dynamic = 'force-dynamic'

// `topicMutationDeps()` deferred to request time — see the identical note in
// `apps/web/app/api/calendar/route.ts`.
export const POST = withAccount((request, context: AccountContext<RouteCtx>) =>
  makeVetoTopicHandler(topicMutationDeps())(request, context),
)

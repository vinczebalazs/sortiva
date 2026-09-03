import { withAccount } from '../../../../auth/_lib/session'
import { topicMutationDeps } from '../../_lib/config'
import { makeVetoTopicHandler } from '../../_lib/mutations'

/**
 * `POST /api/calendar/topics/{topicId}/veto` — free and instant on a
 * `planned` topic; cancels publication (draft discarded, cost absorbed) on a
 * `generating`/`in_review` one. Main §8.7's lock semantics.
 */
export const dynamic = 'force-dynamic'

export const POST = withAccount(makeVetoTopicHandler(topicMutationDeps()))

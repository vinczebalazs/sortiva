import { withAccount } from '../../../../auth/_lib/session'
import { topicMutationDeps } from '../../_lib/config'
import { makeMoveTopicHandler } from '../../_lib/mutations'

/** `POST /api/calendar/topics/{topicId}/move` — drag a planned topic to another future date; swaps with an unpinned occupant. */
export const dynamic = 'force-dynamic'

export const POST = withAccount(makeMoveTopicHandler(topicMutationDeps()))

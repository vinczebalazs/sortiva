import { withAccount } from '../../../../auth/_lib/session'
import { topicMutationDeps } from '../../_lib/config'
import { makePinTopicHandler } from '../../_lib/mutations'

/** `POST /api/calendar/topics/{topicId}/pin` — pin or unpin; replenishment and reordering never move a pinned topic. */
export const dynamic = 'force-dynamic'

export const POST = withAccount(makePinTopicHandler(topicMutationDeps()))

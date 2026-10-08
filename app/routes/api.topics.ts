import type { ActionFunctionArgs } from 'react-router'
import { moveToTop, notInterested, skipTopic } from '../../core/topics/queue.ts'
import { shouldRediscover } from '../../core/topics/discover.ts'
import { requestDiscovery } from '../../jobs/topics.ts'
import { db, requireStore } from '../server/context.server.ts'

const ACTIONS = { not_interested: notInterested, move_to_top: moveToTop, skip: skipTopic }

export async function action({ request }: ActionFunctionArgs) {
  const storeId = requireStore(request)
  const { action, topicId } = (await request.json()) as { action: keyof typeof ACTIONS; topicId: number }
  const run = ACTIONS[action]
  if (!run || !Number.isInteger(topicId)) return Response.json({ error: 'unknown action' }, { status: 400 })
  if (!(await run(db(), storeId, topicId))) return Response.json({ error: 'topic not in the queue' }, { status: 409 })
  if (action !== 'move_to_top' && (await shouldRediscover(db(), storeId))) await requestDiscovery(db(), storeId, 'low_queue', new Date().toISOString().slice(0, 10))
  return Response.json({ ok: true })
}

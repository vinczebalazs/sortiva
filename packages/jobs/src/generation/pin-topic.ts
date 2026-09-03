import { planPin, type ConflictCode } from '@sortiva/core'
import { accountScope, findTopic, pinTopicGuarded, type Db, type TopicRow } from '@sortiva/db'

export interface PinTopicDeps {
  readonly db: Db
  readonly now?: () => Date
}

export interface PinTopicInput {
  readonly accountId: string
  readonly topicId: string
  readonly pinned: boolean
}

export type PinTopicResult =
  | { readonly ok: true; readonly topic: TopicRow }
  | { readonly ok: false; readonly code: ConflictCode | 'not_found' }

export async function pinTopic(deps: PinTopicDeps, input: PinTopicInput): Promise<PinTopicResult> {
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(input.accountId)

  const topic = await findTopic(deps.db, scope, input.topicId)
  if (!topic) return { ok: false, code: 'not_found' }

  const plan = planPin(topic.state)
  if (!plan.ok) return { ok: false, code: plan.code }

  const updated = await pinTopicGuarded(deps.db, scope, topic.id, input.pinned, now)
  if (!updated) return { ok: false, code: 'topic_already_published' }
  return { ok: true, topic: updated }
}

import { moveConflictCodeFor, planMove, toIsoDate, type ConflictCode, type OccupantTopic } from '@sortiva/core'
import {
  accountScope,
  findTopic,
  findTopicOnDate,
  moveTopicGuarded,
  swapTopicDates,
  type AccountScope,
  type Db,
  type TopicRow,
} from '@sortiva/db'

/**
 * Dragging a topic to another day, ui spec §6.1: a plain move onto an empty
 * day, or a swap when the destination already holds an unpinned, movable
 * topic. `packages/core/src/calendar/placement.ts`'s `planMove` is the
 * decision; this is the transaction that carries it out.
 */

export interface MoveTopicDeps {
  readonly db: Db
  readonly now?: () => Date
}

export interface MoveTopicInput {
  readonly accountId: string
  readonly topicId: string
  readonly toDate: string
}

export type MoveTopicResult =
  | { readonly ok: true; readonly topic: TopicRow }
  | { readonly ok: false; readonly code: ConflictCode | 'not_found' }

export async function moveTopic(deps: MoveTopicDeps, input: MoveTopicInput): Promise<MoveTopicResult> {
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(input.accountId)
  const today = toIsoDate(now)

  const topic = await findTopic(deps.db, scope, input.topicId)
  if (!topic) return { ok: false, code: 'not_found' }

  const occupantRow = await findTopicOnDate(deps.db, scope, input.toDate)
  const occupant: OccupantTopic | null =
    occupantRow && occupantRow.id !== topic.id ? asOccupant(occupantRow) : null

  const plan = planMove({ topic: asOccupant(topic), toDate: input.toDate, occupant, today })
  if (!plan.ok) return { ok: false, code: plan.code }

  if (!plan.swap) {
    const moved = await moveTopicGuarded(deps.db, scope, topic.id, input.toDate, now)
    if (!moved) return { ok: false, code: await raceCode(deps.db, scope, topic.id) }
    return { ok: true, topic: moved }
  }

  // `plan.swap` is only ever true when `occupant` is non-null (planMove's own
  // contract), so this cannot be reached with a null occupant — the check
  // exists to keep TypeScript, not the logic, honest.
  if (!occupantRow) return { ok: false, code: 'topic_already_generating' }

  const swapped = await swapTopicDates(
    deps.db,
    scope,
    { topicId: topic.id, date: topic.scheduledDate },
    { topicId: occupantRow.id, date: occupantRow.scheduledDate },
    now,
  )
  if (!swapped) return { ok: false, code: await raceCode(deps.db, scope, topic.id) }
  return { ok: true, topic: swapped.a }
}

function asOccupant(row: TopicRow): OccupantTopic {
  return { id: row.id, state: row.state, pinned: row.pinned, scheduledFor: row.scheduledDate }
}

/**
 * Only reached when a guarded write lost a race after `planMove` already
 * approved it in memory (the topic or its occupant moved on between the read
 * and the write). Re-reads the row that changed under us to name the code
 * accurately rather than guessing.
 */
async function raceCode(db: Db, scope: AccountScope, topicId: string): Promise<ConflictCode> {
  const row = await findTopic(db, scope, topicId)
  return moveConflictCodeFor(row?.state ?? 'generating')
}

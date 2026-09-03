import {
  accountAttribution,
  topicFingerprint,
  OPPORTUNITY_STATUS_CHANGED_EVENT,
  VETO_CONFLICT_CODE,
  type ConflictCode,
  type Logger,
  type PosthogCapture,
} from '@sortiva/core'
import {
  accountScope,
  discardDraftForTopic,
  dismissOpportunityGuarded,
  insertNotInterested,
  vetoTopicGuarded,
  type Db,
  type TopicRow,
} from '@sortiva/db'
import { runtimeLogger } from '../runtime/logging'

/**
 * The veto operation in full, main §8.7: free and instant on a `planned`
 * topic; on a `generating` (or `in_review`) one, "cancels *publication* - the
 * draft is discarded ... but the generation cost is already spent; we absorb
 * it." Four things happen together, none of them optional:
 *
 *  1. The guarded transition itself (`planned`/`generating`/`in_review` →
 *     `vetoed`) — the only step that can fail the whole operation.
 *  2. Any draft article already tied to this topic is discarded. A no-op
 *     when there is none (the common `planned` case).
 *  3. The topic's own search term is recorded on the `not_interested` list,
 *     so it is never re-proposed (main §8.7).
 *  4. The originating opportunity is dismissed, main §7.9 ("dismissed - user
 *     said no; goes to the not-interested list") — best-effort: if it has
 *     already moved on (e.g. it was already `completed`), the veto still
 *     succeeds, because the topic's own state is what this operation is
 *     really about.
 */

export interface VetoTopicDeps {
  readonly db: Db
  readonly now?: () => Date
  readonly logger?: Logger
  readonly capture?: Pick<PosthogCapture, 'capture'>
}

export interface VetoTopicInput {
  readonly accountId: string
  readonly topicId: string
  readonly reason?: string | null
}

export type VetoTopicResult =
  | { readonly ok: true; readonly topic: TopicRow; readonly draftDiscarded: boolean }
  | { readonly ok: false; readonly code: ConflictCode }

export async function vetoTopic(deps: VetoTopicDeps, input: VetoTopicInput): Promise<VetoTopicResult> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(input.accountId)

  const updated = await vetoTopicGuarded(deps.db, scope, input.topicId, input.reason ?? null, now)
  if (!updated) return { ok: false, code: VETO_CONFLICT_CODE }

  const discarded = await discardDraftForTopic(deps.db, scope, updated.id, now)

  const term = updated.targetKeyword ?? updated.title
  await insertNotInterested(deps.db, scope, topicFingerprint(term), now)

  const dismissal = await dismissOpportunityGuarded(deps.db, scope, updated.opportunityId, now)
  if (dismissal) {
    deps.capture?.capture({
      event: OPPORTUNITY_STATUS_CHANGED_EVENT,
      attribution: accountAttribution(input.accountId),
      properties: { from: dismissal.from, to: 'dismissed', actor: 'user' },
    })
  }

  log.info('topic_vetoed', {
    account_id: input.accountId,
    topic_id: updated.id,
    draft_discarded: discarded !== undefined,
  })

  return { ok: true, topic: updated, draftDiscarded: discarded !== undefined }
}

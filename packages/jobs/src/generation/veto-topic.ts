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
  findArticleForTopic,
  findLiveTopicForOpportunity,
  hasPendingPublishForArticle,
  insertNotInterested,
  vetoTopicGuarded,
  type AccountScope,
  type Db,
  type OpportunityRow,
  type TopicRow,
} from '@sortiva/db'
import { runtimeLogger } from '../runtime/logging'

/**
 * Calling off a day on the calendar — from the calendar itself, and from the
 * merchant saying "not interested" to the suggestion that booked it.
 *
 * Both are the same act, and they run the same steps here rather than each
 * reaching into the calendar's rows separately. Four things happen together,
 * none of them optional:
 *
 *  1. The guarded transition itself (`planned`/`generating`/`in_review` →
 *     `vetoed`).
 *  2. Any draft article already written for that day is discarded. A no-op
 *     when the writing has not got that far, which is the common case for a
 *     day that was only ever planned.
 *  3. The day's own search term is recorded on the not-interested list, so
 *     replenishment never books it again — otherwise the same article comes
 *     back a month later and the cancellation was only a delay.
 *  4. The suggestion behind the day is dismissed.
 *
 * Free and instant on a day that is only planned; on one already being
 * written, main §8.7's rule is that cancelling stops the *publication* — the
 * generation cost is already spent and we absorb it. The article that run goes
 * on to write is never delivered: `articlesReadyForDelivery` skips a called-off
 * day, so it does not matter whether the cancellation or the writing landed
 * first.
 *
 * **All of it is one database transaction, and a lost guard rolls the lot
 * back.** The thing being raced is a publication: between the moment a
 * publication claims an article and the moment it writes it down as published,
 * the post can already be live on the merchant's shop. So a cancellation that
 * cannot discard the draft it just read, or that finds a publication already
 * claimed, does nothing at all and says so — rather than cancelling the day,
 * dismissing the suggestion, and leaving the article on the merchant's blog,
 * which is the exact thing this is here to prevent.
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

/**
 * Why a cancellation did not happen, in the calendar's own terms. Each caller
 * translates these into the codes its own route is allowed to answer with.
 *
 * `topic_resolved` — the day has already had its outcome, or a publication of
 * its article is in flight or done; there is nothing left to call off.
 * `opportunity_not_open` — the suggestion behind the day had already moved on,
 * so the dismissal half could not be performed.
 */
export type CancellationRefusal = 'topic_resolved' | 'opportunity_not_open'

/** Rolls the whole cancellation back. Carries which guard lost, for the caller's answer. */
class CancellationLost extends Error {
  constructor(readonly refusal: CancellationRefusal) {
    super(`the cancellation lost a guarded transition: ${refusal}`)
    this.name = 'CancellationLost'
  }
}

interface CancellationOutcome {
  readonly topic: TopicRow
  readonly draftDiscarded: boolean
  readonly dismissedFrom: OpportunityRow['status'] | null
}

/**
 * The steps above, in one transaction.
 *
 * `dismissal: 'required'` is the merchant-dismissing-the-suggestion entry
 * point, where failing to dismiss is a failure of the whole operation. The
 * calendar's own veto passes `best_effort` instead: a suggestion that has
 * already moved on does not stop a day being called off, because the day is
 * what that operation is about.
 */
async function cancelDay(
  db: Db,
  scope: AccountScope,
  input: {
    readonly topicId: string
    readonly reason: string | null
    readonly dismissal: 'required' | 'best_effort'
  },
  now: Date,
): Promise<CancellationOutcome | { readonly refused: CancellationRefusal }> {
  try {
    return await db.transaction(async (tx) => {
      const updated = await vetoTopicGuarded(tx, scope, input.topicId, input.reason, now)
      if (!updated) throw new CancellationLost('topic_resolved')

      const article = await findArticleForTopic(tx, scope, input.topicId)
      let draftDiscarded = false
      if (article) {
        if (article.state === 'published') throw new CancellationLost('topic_resolved')
        // The claim is written before the post is sent, so a pending one means
        // the article may already be on the shop even though our own row still
        // calls it a draft.
        if (await hasPendingPublishForArticle(tx, scope, article.id)) {
          throw new CancellationLost('topic_resolved')
        }
        if (article.state === 'draft' || article.state === 'in_review') {
          // Zero rows here is the race itself: a publication moved this article
          // between the read a moment ago and this write, so it won and we stop
          // (invariant 15).
          const discarded = await discardDraftForTopic(tx, scope, input.topicId, now)
          if (!discarded) throw new CancellationLost('topic_resolved')
          draftDiscarded = true
        }
      }

      const term = updated.targetKeyword ?? updated.title
      await insertNotInterested(tx, scope, topicFingerprint(term), now)

      const dismissal = await dismissOpportunityGuarded(tx, scope, updated.opportunityId, now)
      if (!dismissal && input.dismissal === 'required') {
        throw new CancellationLost('opportunity_not_open')
      }

      return { topic: updated, draftDiscarded, dismissedFrom: dismissal?.from ?? null }
    })
  } catch (error) {
    if (error instanceof CancellationLost) return { refused: error.refusal }
    throw error
  }
}

function wasRefused(
  outcome: CancellationOutcome | { readonly refused: CancellationRefusal },
): outcome is { readonly refused: CancellationRefusal } {
  return 'refused' in outcome
}

export async function vetoTopic(deps: VetoTopicDeps, input: VetoTopicInput): Promise<VetoTopicResult> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(input.accountId)

  const outcome = await cancelDay(
    deps.db,
    scope,
    { topicId: input.topicId, reason: input.reason ?? null, dismissal: 'best_effort' },
    now,
  )
  // The frozen contract gives this route one conflict code, and every reason a
  // veto can be refused says the same thing to a merchant: it is too late.
  if (wasRefused(outcome)) return { ok: false, code: VETO_CONFLICT_CODE }

  captureDismissal(deps, input.accountId, outcome.dismissedFrom)

  log.info('topic_vetoed', {
    account_id: input.accountId,
    topic_id: outcome.topic.id,
    draft_discarded: outcome.draftDiscarded,
  })

  return { ok: true, topic: outcome.topic, draftDiscarded: outcome.draftDiscarded }
}

export interface DismissOpportunityInput {
  readonly accountId: string
  readonly opportunityId: string
}

export type DismissOpportunityResult =
  | {
      readonly ok: true
      /** The day called off with it, or `null` when the suggestion had booked none. */
      readonly topic: TopicRow | null
      readonly draftDiscarded: boolean
      readonly status: OpportunityRow['status']
    }
  | { readonly ok: false; readonly refusal: CancellationRefusal }

/**
 * The merchant says "not interested" to a suggestion.
 *
 * If that suggestion has booked a day on the calendar, the day goes with it —
 * the founder's decision (2026-09-07): dismissal and the calendar's own veto
 * are one act rather than two, because otherwise the product tells a merchant
 * it has dropped something and then publishes it anyway.
 *
 * The day is left *empty*, not handed to something else. A cancelled day is a
 * gap the calendar keeps: nothing is pulled forward into it, so no article ever
 * turns up on a day the merchant was told would be quiet.
 *
 * A suggestion whose article has already gone out has no day left to call off,
 * and is dismissed on its own — exactly what happened before this existed. What
 * is refused is the *race*: a publication landing while the cancellation runs
 * takes the whole cancellation with it, rather than half of it.
 */
export async function dismissOpportunity(
  deps: VetoTopicDeps,
  input: DismissOpportunityInput,
): Promise<DismissOpportunityResult> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(input.accountId)

  const topic = await findLiveTopicForOpportunity(deps.db, scope, input.opportunityId)
  if (!topic) {
    const dismissal = await dismissOpportunityGuarded(deps.db, scope, input.opportunityId, now)
    if (!dismissal) return { ok: false, refusal: 'opportunity_not_open' }
    captureDismissal(deps, input.accountId, dismissal.from)
    return { ok: true, topic: null, draftDiscarded: false, status: dismissal.row.status }
  }

  const outcome = await cancelDay(
    deps.db,
    scope,
    { topicId: topic.id, reason: null, dismissal: 'required' },
    now,
  )
  if (wasRefused(outcome)) return { ok: false, refusal: outcome.refused }

  captureDismissal(deps, input.accountId, outcome.dismissedFrom)

  log.info('opportunity_dismissed_with_topic', {
    account_id: input.accountId,
    opportunity_id: input.opportunityId,
    topic_id: outcome.topic.id,
    scheduled_date: outcome.topic.scheduledDate,
    draft_discarded: outcome.draftDiscarded,
  })

  return { ok: true, topic: outcome.topic, draftDiscarded: outcome.draftDiscarded, status: 'dismissed' }
}

function captureDismissal(
  deps: VetoTopicDeps,
  accountId: string,
  from: OpportunityRow['status'] | null,
): void {
  if (!from) return
  deps.capture?.capture({
    event: OPPORTUNITY_STATUS_CHANGED_EVENT,
    attribution: accountAttribution(accountId),
    properties: { from, to: 'dismissed', actor: 'user' },
  })
}

import { accountAttribution, type PosthogCapture } from '../contracts/analytics'
import type { NotificationType } from '../contracts/opportunities'
import { captureStubUsed, registerStub } from '../contracts/stubs'
import {
  OPTIMIZE_UNAPPLIED_DAYS,
  cutoffDaysBefore,
  type AttentionCandidate,
  type AttentionSources,
} from './attention'
import type { NotificationRefs } from './refs'

/**
 * What the bell and the attention list need from storage, as a port: the web
 * layer talks to this and never holds a database handle, and the same two
 * screens can be driven by a fake in a test.
 */

export interface NotificationView {
  readonly id: string
  readonly type: NotificationType
  readonly refs: NotificationRefs
  readonly createdAt: Date
  readonly seenAt: Date | null
  readonly readAt: Date | null
}

export interface NotificationStore {
  list(accountId: string, options: { since?: Date; limit?: number }): Promise<NotificationView[]>
  unseenCount(accountId: string): Promise<number>
  /** Opening the bell. Returns how many were still unseen. */
  markSeen(accountId: string): Promise<number>
  /** False when the id belongs to nobody, or to somebody else. */
  markRead(accountId: string, notificationId: string): Promise<boolean>
  openMerchantTasks(accountId: string): Promise<readonly AttentionCandidate[]>
  unappliedOptimizeRecommendations(
    accountId: string,
    generatedBefore: Date,
  ): Promise<readonly AttentionCandidate[]>
}

export interface NotificationFeed {
  readonly notifications: readonly NotificationView[]
  readonly unseenCount: number
}

/**
 * One poll of the bell. `since` is the browser's own high-water mark, so the
 * ordinary case — a merchant with the tab open and nothing happening — reads
 * an index and returns an empty list with a count.
 */
export async function notificationFeed(
  store: NotificationStore,
  accountId: string,
  options: { since?: Date; limit?: number } = {},
): Promise<NotificationFeed> {
  const [notifications, unseenCount] = await Promise.all([
    store.list(accountId, options),
    store.unseenCount(accountId),
  ])
  return { notifications, unseenCount }
}

/**
 * Two of the attention list's five conditions can be read today. The other
 * three — a draft waiting for review, an article needing a repair, an exported
 * article whose published address we were never told — all sit on the
 * `articles` table, which schema wave 3 creates and which does not exist yet.
 *
 * They return nothing, but they say so: registered as a wired stub, so
 * `pnpm stubs:report` names them and any call that reaches one shows up as
 * `stub_used` rather than as an empty list nobody thinks to question. An
 * attention list that silently cannot see drafts would look exactly like an
 * account with no drafts.
 */
export const ARTICLE_ATTENTION_STUB = 'AttentionSources.articles'

registerStub({
  contract: ARTICLE_ATTENTION_STUB,
  filledBy: 'D — T4.0 (schema wave 3: articles and repairs)',
  behaviour:
    'drafts awaiting review, pending repairs and unconfirmed export URLs return nothing; the articles table does not exist yet',
  mustBeGoneBy: 'M4',
})

export function attentionSourcesFor(
  store: NotificationStore,
  accountId: string,
  capture?: Pick<PosthogCapture, 'capture'>,
): AttentionSources {
  const attribution = accountAttribution(accountId)

  const pendingOnArticles = async (condition: string): Promise<readonly AttentionCandidate[]> => {
    captureStubUsed(capture, ARTICLE_ATTENTION_STUB, attribution, { condition })
    return []
  }

  return {
    draftsAwaitingReview: () => pendingOnArticles('draft_awaiting_review'),
    pendingRepairs: () => pendingOnArticles('repair_pending'),
    unconfirmedExportUrls: () => pendingOnArticles('export_url_unconfirmed'),
    openMerchantTasks: () => store.openMerchantTasks(accountId),
    unappliedOptimizeRecommendations: (now) =>
      store.unappliedOptimizeRecommendations(
        accountId,
        cutoffDaysBefore(now, OPTIMIZE_UNAPPLIED_DAYS),
      ),
  }
}

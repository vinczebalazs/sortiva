import { accountAttribution, type PosthogCapture } from '../contracts/analytics'
import type { NotificationType } from '../contracts/opportunities'
import { captureStubUsed, registerStub } from '../contracts/stubs'
import {
  EXPORT_URL_UNCONFIRMED_DAYS,
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
  /** Drafts the merchant asked to see before publication — main §9.3. */
  draftsAwaitingReview(accountId: string): Promise<readonly AttentionCandidate[]>
  /** Exported articles live for longer than the window with no address told to us. */
  unconfirmedExportUrls(
    accountId: string,
    publishedBefore: Date,
  ): Promise<readonly AttentionCandidate[]>
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
 * Four of the attention list's five conditions are real reads. The fifth — an
 * article needing a repair after the catalogue moved underneath it — has no
 * table to read: there is no repairs table anywhere in the schema, and `T5.3`
 * is the card that introduces one.
 *
 * It returns nothing, and it says so: registered as a wired stub, so
 * `pnpm stubs:report` names it and any call that reaches it shows up as
 * `stub_used` rather than as an empty list nobody thinks to question. An
 * attention list that silently cannot see repairs would look exactly like an
 * account with nothing broken.
 */
export const ARTICLE_ATTENTION_STUB = 'AttentionSources.articles'

registerStub({
  contract: ARTICLE_ATTENTION_STUB,
  filledBy: 'D — T5.3 (the repair queue and the table behind it)',
  behaviour:
    'pending repairs return nothing; no repairs table exists in the schema yet, so nothing can be read',
  mustBeGoneBy: 'M5',
})

export function attentionSourcesFor(
  store: NotificationStore,
  accountId: string,
  capture?: Pick<PosthogCapture, 'capture'>,
): AttentionSources {
  const attribution = accountAttribution(accountId)

  return {
    draftsAwaitingReview: () => store.draftsAwaitingReview(accountId),
    pendingRepairs: async () => {
      captureStubUsed(capture, ARTICLE_ATTENTION_STUB, attribution, {
        condition: 'repair_pending',
      })
      return []
    },
    unconfirmedExportUrls: (now) =>
      store.unconfirmedExportUrls(
        accountId,
        cutoffDaysBefore(now, EXPORT_URL_UNCONFIRMED_DAYS),
      ),
    openMerchantTasks: () => store.openMerchantTasks(accountId),
    unappliedOptimizeRecommendations: (now) =>
      store.unappliedOptimizeRecommendations(
        accountId,
        cutoffDaysBefore(now, OPTIMIZE_UNAPPLIED_DAYS),
      ),
  }
}

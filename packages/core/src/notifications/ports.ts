import type { PosthogCapture } from '../contracts/analytics'
import type { NotificationType } from '../contracts/opportunities'
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
  /** Published articles whose products moved under them and that are still waiting on somebody. */
  pendingRepairs(accountId: string): Promise<readonly AttentionCandidate[]>
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
 * All five of the attention list's conditions are real reads.
 *
 * Pending repairs was the last stand-in here. It returned nothing and said so,
 * because there was no way to tell "this store has nothing broken" from "we
 * cannot see whether anything is broken" — and an attention list that silently
 * cannot see repairs looks exactly like a healthy account. It now reads the
 * store's own open repairs.
 */
export function attentionSourcesFor(
  store: NotificationStore,
  accountId: string,
  _capture?: Pick<PosthogCapture, 'capture'>,
): AttentionSources {
  return {
    draftsAwaitingReview: () => store.draftsAwaitingReview(accountId),
    pendingRepairs: () => store.pendingRepairs(accountId),
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

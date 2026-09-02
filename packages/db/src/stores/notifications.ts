import type { NotificationStore, NotificationView } from '@sortiva/core'
import { db, type Db } from '../client'
import {
  countUnseenNotifications,
  listNotifications,
  markNotificationRead,
  markNotificationsSeen,
  openMerchantTasks,
  unappliedOptimizeRecommendations,
} from '../repositories/notifications'
import { accountScope } from '../scope'

/**
 * Binds the bell and the attention list to this deployment's database.
 *
 * It lives here, beside the queries, for the same reason the Search Console
 * store does: a database handle outside this package is how a query ends up
 * running without naming the account it is for. The web layer is handed this
 * port and holds nothing.
 */
export interface NotificationStoreOptions {
  /** An integration test hands in its own isolated database; production uses the pool. */
  database?: Db
}

export function makeNotificationStore(options: NotificationStoreOptions = {}): NotificationStore {
  const database = (): Db => options.database ?? db()

  return {
    async list(accountId, listOptions): Promise<NotificationView[]> {
      const rows = await listNotifications(database(), accountScope(accountId), listOptions)
      return rows.map((row) => ({
        id: row.id,
        type: row.type,
        // Stored payloads are references only, and the guard on the way in is
        // what makes that true; this is the read side taking it at its word.
        refs: (row.payloadJson ?? {}) as Record<string, string>,
        createdAt: row.createdAt,
        seenAt: row.seenAt,
        readAt: row.readAt,
      }))
    },

    unseenCount(accountId) {
      return countUnseenNotifications(database(), accountScope(accountId))
    },

    markSeen(accountId) {
      return markNotificationsSeen(database(), accountScope(accountId))
    },

    markRead(accountId, notificationId) {
      return markNotificationRead(database(), accountScope(accountId), notificationId)
    },

    openMerchantTasks(accountId) {
      return openMerchantTasks(database(), accountScope(accountId))
    },

    unappliedOptimizeRecommendations(accountId, generatedBefore) {
      return unappliedOptimizeRecommendations(
        database(),
        accountScope(accountId),
        generatedBefore,
      )
    },
  }
}

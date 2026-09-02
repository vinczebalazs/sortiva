import {
  attentionSourcesFor,
  buildAttentionList,
  notificationFeed,
  notificationsQuerySchema,
  type NotificationStore,
} from '@sortiva/core'
import { makeNotificationStore } from '@sortiva/db'
import type { AccountHandler } from '../../auth/_lib/session'

/**
 * The bell and the dashboard's attention list.
 *
 * Both are polled — the bell every thirty seconds — so both are cheap reads and
 * neither is gated on billing: a merchant whose payment failed still needs to be
 * told their payment failed.
 *
 * The two are built differently on purpose. Notifications are stored history:
 * they are rows, they carry read state, and they stay after the thing they
 * describe is dealt with. Attention items are a query over what is true right
 * now, so approving the draft removes the item by making the condition false —
 * there is no row to clear and nothing to get out of step.
 */

type Store = NotificationStore

export function makeNotificationsHandler(store: Store = makeNotificationStore()): AccountHandler {
  return async (request, { scope }) => {
    const query = notificationsQuerySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    )
    if (!query.success) {
      return badRequest('invalid_since', 'The `since` parameter must be an ISO date-time.')
    }

    const since = query.data.since ? new Date(query.data.since) : undefined
    const feed = await notificationFeed(store, scope.accountId, { since })

    return Response.json({
      notifications: feed.notifications.map((item) => ({
        id: item.id,
        type: item.type,
        refs: item.refs,
        createdAt: item.createdAt.toISOString(),
        seenAt: item.seenAt?.toISOString() ?? null,
        readAt: item.readAt?.toISOString() ?? null,
      })),
      unseenCount: feed.unseenCount,
    })
  }
}

export function makeSeenHandler(store: Store = makeNotificationStore()): AccountHandler {
  return async (_request, { scope }) => {
    await store.markSeen(scope.accountId)
    return Response.json({ ok: true })
  }
}

export function makeReadHandler(
  store: Store = makeNotificationStore(),
): AccountHandler<{ params: Promise<{ notificationId: string }> }> {
  return async (_request, { scope, route }) => {
    const { notificationId } = await route.params
    const marked = await store.markRead(scope.accountId, notificationId)
    if (!marked) {
      // Someone else's notification and a deleted one are the same answer, so
      // the response cannot be used to learn that an id exists.
      return Response.json(
        { error: { code: 'notification_not_found', message: 'That notification is gone.' } },
        { status: 404 },
      )
    }
    return Response.json({ ok: true })
  }
}

export function makeAttentionHandler(store: Store = makeNotificationStore()): AccountHandler {
  return async (_request, { scope }) => {
    const items = await buildAttentionList(attentionSourcesFor(store, scope.accountId))
    return Response.json({
      items: items.map((item) => ({
        kind: item.kind,
        refs: item.refs,
        since: item.since.toISOString(),
      })),
    })
  }
}

function badRequest(code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status: 400 })
}

export const notificationsHandler = makeNotificationsHandler()
export const notificationsSeenHandler = makeSeenHandler()
export const notificationReadHandler = makeReadHandler()
export const attentionHandler = makeAttentionHandler()

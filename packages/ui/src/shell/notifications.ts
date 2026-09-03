// Narrow, browser-safe imports rather than the `@sortiva/core` barrel: that
// barrel's `index.ts` re-exports every domain module, several of which reach
// for `node:crypto` / `node:fs` at the top of the file, and a client
// component (this module is imported by `NotificationBell`) that drags one of
// those into the bundle fails the Next.js build outright.
import { renderNotification } from '@sortiva/core/notifications/render'
import type { NotificationRefs } from '@sortiva/core/notifications/refs'
import type { NotificationType } from '@sortiva/core/contracts/opportunities'
import type { StringKey } from '../strings'

/**
 * The bell's own arithmetic: merging what a 30s poll returns into what is
 * already on screen, and turning one stored row into the copy key and
 * placeholders a line renders from.
 *
 * tech §1.6 fixes the interval and the endpoint shape (`GET
 * /api/notifications?since=` — unseen count plus recent items); what happens
 * to two overlapping reads of the same feed is this module's to decide.
 */

export interface NotificationItem {
  readonly id: string
  readonly type: NotificationType
  readonly refs: NotificationRefs
  readonly createdAt: string
  readonly seenAt: string | null
  readonly readAt: string | null
}

/**
 * Folds a poll's rows into what is already held, newest first, each id once.
 * A row that came back again (its `seenAt`/`readAt` may have changed) replaces
 * its old copy rather than duplicating it.
 */
export function mergeNotifications(
  existing: readonly NotificationItem[],
  incoming: readonly NotificationItem[],
): readonly NotificationItem[] {
  const byId = new Map(existing.map((item) => [item.id, item]))
  for (const item of incoming) byId.set(item.id, item)
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** What the row renders as: a copy key and its placeholders, from `refs` alone. */
export function notificationLine(item: Pick<NotificationItem, 'type' | 'refs'>): {
  readonly stringKey: StringKey
  readonly params: Readonly<Record<string, string | number>>
} {
  // No `resolved` argument: turning a `refs` id into the display text it
  // names (an article's title, a page's URL) has no lookup built anywhere in
  // the product yet, so every line whose sentence needs one renders its
  // `.generic` sibling instead — the renderer's own designed degrade path,
  // not a shortcut taken here. Recorded in `DECISIONS.md` 2026-09-03 T9.7.
  const rendered = renderNotification({ type: item.type, refs: item.refs })
  return { stringKey: rendered.stringKey as StringKey, params: rendered.params }
}

/** The label the bell button carries — plain vs. "unread", per ui §11 / tech §1.6. */
export function bellAriaLabelKey(unseenCount: number): StringKey {
  return unseenCount > 0 ? 'shell.notificationsUnread' : 'shell.notifications'
}

/** Every 30s, per tech §1.6 — not a threshold about product behaviour, so it lives beside the code that uses it rather than in `packages/rules`. */
export const NOTIFICATIONS_POLL_MS = 30_000

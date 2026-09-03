'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createTranslate, DEFAULT_LANGUAGE, type UiLanguage } from '../strings'
import { BellIcon, CloseIcon } from './icons'
import {
  bellAriaLabelKey,
  mergeNotifications,
  notificationLine,
  NOTIFICATIONS_POLL_MS,
  type NotificationItem,
} from './notifications'

/**
 * The bell in the shell's toolbar: badge, poll, and the list it opens onto.
 *
 * tech §1.6: polling rather than a push channel, thirty seconds apart — the
 * freshest thing this product does moves once a day, so a badge running up to
 * thirty seconds behind is invisible. Two tiers of read state, per ui §11's
 * "notification bell → notification list" and the schema's `seenAt`/`readAt`
 * columns: opening the bell clears the badge for everything at once (`seen`);
 * clicking one row marks that row specifically (`read`), which is what a
 * returning merchant would use to tell "already looked at this" from "already
 * dealt with this" apart.
 *
 * `language` rather than a `t` function: the shell that renders this reads the
 * merchant's language on the server, and a translate function is a closure
 * React refuses to serialise across the server/client boundary — passing one
 * from the layout down to this component 500s in a production build (found by
 * `T9.8`, driving this screen against one for the first time). A language code
 * survives that boundary; the translator is built here instead, on the client
 * this component already runs on.
 */

export interface NotificationBellProps {
  readonly language?: UiLanguage
  readonly feedEndpoint?: string
  readonly seenEndpoint?: string
  readonly readEndpoint?: (id: string) => string
  readonly pollMs?: number
}

export function NotificationBell({
  language = DEFAULT_LANGUAGE,
  feedEndpoint = '/api/notifications',
  seenEndpoint = '/api/notifications/seen',
  readEndpoint = (id) => `/api/notifications/${id}/read`,
  pollMs = NOTIFICATIONS_POLL_MS,
}: NotificationBellProps) {
  const t = useMemo(() => createTranslate(language), [language])
  const [items, setItems] = useState<readonly NotificationItem[]>([])
  const [unseenCount, setUnseenCount] = useState(0)
  const [open, setOpen] = useState(false)
  const sinceRef = useRef<string | null>(null)

  useEffect(() => {
    let stopped = false

    async function poll() {
      try {
        const url = sinceRef.current
          ? `${feedEndpoint}?since=${encodeURIComponent(sinceRef.current)}`
          : feedEndpoint
        const response = await fetch(url, { cache: 'no-store' })
        if (!response.ok || stopped) return
        const body = (await response.json()) as {
          notifications: readonly NotificationItem[]
          unseenCount: number
        }
        setItems((current) => mergeNotifications(current, body.notifications))
        setUnseenCount(body.unseenCount)
        const latest = body.notifications[0]?.createdAt
        if (latest) sinceRef.current = latest
      } catch {
        // A missed poll is invisible at 30s granularity; the next one covers it.
      }
    }

    void poll()
    const interval = setInterval(() => void poll(), pollMs)
    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [feedEndpoint, pollMs])

  async function toggleOpen() {
    const next = !open
    setOpen(next)
    if (next && unseenCount > 0) {
      setUnseenCount(0)
      try {
        await fetch(seenEndpoint, { method: 'POST' })
      } catch {
        // The badge already reads zero on screen; the next poll is the truth.
      }
    }
  }

  async function markRead(id: string) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, readAt: item.readAt ?? new Date().toISOString() } : item)))
    try {
      await fetch(readEndpoint(id), { method: 'POST' })
    } catch {
      // Already marked on screen; the next poll is the truth.
    }
  }

  return (
    <div className="sortiva-bell">
      <button
        type="button"
        className="sortiva-bell__button"
        aria-label={t(bellAriaLabelKey(unseenCount))}
        aria-expanded={open}
        onClick={() => void toggleOpen()}
      >
        <BellIcon />
        {unseenCount > 0 ? (
          <span className="sortiva-bell__badge" data-testid="bell-unseen-count">
            {unseenCount > 9 ? '9+' : unseenCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="sortiva-bell__panel" role="dialog" aria-label={t('shell.bell.heading')}>
          <div className="sortiva-bell__panel-head">
            <h2>{t('shell.bell.heading')}</h2>
            <button type="button" aria-label={t('shell.bell.close')} onClick={() => setOpen(false)}>
              <CloseIcon />
            </button>
          </div>

          {items.length === 0 ? (
            <p className="sortiva-bell__empty">{t('shell.bell.empty')}</p>
          ) : (
            <ul className="sortiva-bell__list">
              {items.map((item) => {
                const line = notificationLine(item)
                return (
                  <li key={item.id} data-notification-read={item.readAt ? 'true' : 'false'}>
                    <button type="button" onClick={() => void markRead(item.id)}>
                      {t(line.stringKey, line.params)}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}

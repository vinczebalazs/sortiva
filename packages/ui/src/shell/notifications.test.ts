import { describe, expect, it } from 'vitest'
import en from '../../strings/en.json'
import {
  bellAriaLabelKey,
  mergeNotifications,
  notificationLine,
  NOTIFICATIONS_POLL_MS,
  type NotificationItem,
} from './notifications'

function item(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'n1',
    type: 'opportunities_ready',
    refs: {},
    createdAt: '2026-02-02T09:00:00.000Z',
    seenAt: null,
    readAt: null,
    ...overrides,
  }
}

describe('polling interval', () => {
  it('is thirty seconds, per tech §1.6', () => {
    expect(NOTIFICATIONS_POLL_MS).toBe(30_000)
  })
})

describe('merging a poll into what is already held', () => {
  it('keeps a new row', () => {
    expect(mergeNotifications([], [item()])).toEqual([item()])
  })

  it('replaces a row seen before rather than duplicating it', () => {
    const before = [item({ seenAt: null })]
    const after = mergeNotifications(before, [item({ seenAt: '2026-02-02T09:05:00.000Z' })])
    expect(after).toHaveLength(1)
    expect(after[0]!.seenAt).toBe('2026-02-02T09:05:00.000Z')
  })

  it('sorts newest first', () => {
    const older = item({ id: 'old', createdAt: '2026-02-01T00:00:00.000Z' })
    const newer = item({ id: 'new', createdAt: '2026-02-03T00:00:00.000Z' })
    expect(mergeNotifications([], [older, newer]).map((n) => n.id)).toEqual(['new', 'old'])
  })
})

describe('rendering a row', () => {
  it('falls back to the generic line when nothing was resolved', () => {
    const line = notificationLine(item({ type: 'opportunities_ready' }))
    expect(line.stringKey).toBe('notification.opportunitiesReady.generic')
    expect(en).toHaveProperty(line.stringKey)
  })

  it('renders directly from `refs` for a type whose value is stored rather than resolved', () => {
    const line = notificationLine(
      item({ type: 'monthly_summary_ready', refs: { period: '2026-01' } }),
    )
    expect(line.stringKey).toBe('notification.monthlySummaryReady')
    expect(line.params).toEqual({ period: '2026-01' })
  })

  it('renders a type with no gaps to fill at all', () => {
    const line = notificationLine(item({ type: 'connection_lost_shopify' }))
    expect(line.stringKey).toBe('notification.connectionLostShopify')
    expect(en).toHaveProperty(line.stringKey)
  })
})

describe('the bell button label', () => {
  it('says "unread" once something is unseen', () => {
    expect(bellAriaLabelKey(1)).toBe('shell.notificationsUnread')
    expect(bellAriaLabelKey(0)).toBe('shell.notifications')
  })
})

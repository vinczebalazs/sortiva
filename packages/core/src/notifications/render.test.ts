import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NOTIFICATION_TYPES } from '../contracts/opportunities'
import { attentionStringKeys } from './attention'
import { notificationStringKeys, renderNotification } from './render'

describe('rendering a notification', () => {
  it('names the thing when the thing still exists', () => {
    expect(
      renderNotification({
        type: 'article_published',
        refs: { article_id: 'a-1' },
        resolved: { article_id: 'How to store a wool coat' },
      }),
    ).toEqual({
      stringKey: 'notification.articlePublished',
      params: { title: 'How to store a wool coat' },
      generic: false,
    })
  })

  it('falls back to the generic line when the referenced thing is gone', () => {
    // The article was deleted after the notification was written. There is no
    // title to show, and showing the one from six weeks ago would be a lie.
    expect(
      renderNotification({ type: 'article_published', refs: { article_id: 'a-1' }, resolved: {} }),
    ).toEqual({
      stringKey: 'notification.articlePublished.generic',
      params: {},
      generic: true,
    })
  })

  it('treats an empty lookup result as gone, not as a blank title', () => {
    expect(
      renderNotification({
        type: 'draft_ready_for_review',
        refs: { article_id: 'a-2' },
        resolved: { article_id: '' },
      }).generic,
    ).toBe(true)
  })

  it('reads a period straight out of the payload — it is the value, not a lookup', () => {
    expect(renderNotification({ type: 'monthly_summary_ready', refs: { period: '2026-08' } })).toEqual(
      { stringKey: 'notification.monthlySummaryReady', params: { period: '2026-08' }, generic: false },
    )
  })

  it('never goes generic for an event that references nothing', () => {
    for (const type of ['payment_failed', 'connection_lost_gsc', 'oauth_reminder'] as const) {
      expect(renderNotification({ type, refs: {} }).generic).toBe(false)
    }
  })

  it('has a line for every type in the closed enum', () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(() => renderNotification({ type, refs: {}, resolved: {} })).not.toThrow()
    }
  })
})

/**
 * The renderer produces keys; the words live in `packages/ui/strings/en.json`.
 * Nothing else connects the two, so this reads the catalogue as a file: a key
 * the renderer can emit and the catalogue does not hold would otherwise throw
 * in a merchant's bell, in production, on a code path no unit test walks.
 */
describe('every line the renderer can ask for exists in the string catalogue', () => {
  const catalogue = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../ui/strings/en.json', import.meta.url)), 'utf8'),
  ) as Record<string, string>

  it('holds every notification key', () => {
    const missing = notificationStringKeys().filter((key) => !(key in catalogue))
    expect(missing).toEqual([])
  })

  it('holds every attention-item key', () => {
    const missing = attentionStringKeys().filter((key) => !(key in catalogue))
    expect(missing).toEqual([])
  })

  it('leaves the placeholders the renderer fills', () => {
    expect(catalogue['notification.articlePublished']).toContain('{title}')
    expect(catalogue['notification.opportunitiesReady']).toContain('{count}')
    // The generic line has nothing to fill: that is the point of it.
    expect(catalogue['notification.articlePublished.generic']).not.toContain('{')
  })
})

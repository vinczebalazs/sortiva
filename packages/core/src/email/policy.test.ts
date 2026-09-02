import { describe, expect, it } from 'vitest'
import { NOTIFICATION_TYPES, type NotificationType } from '../contracts/opportunities'
import { notificationChannels } from '../notifications/matrix'
import {
  CARRIED_BY_MONTHLY_SUMMARY,
  defaultNotificationPreferences,
  emailFanOut,
  emailWanted,
  needsUnsubscribe,
  type EmailAudience,
} from './policy'

const reachable: EmailAudience = { suppressed: false }

describe('email fan-out', () => {
  it('sends nothing for a kind the merchant asked for themselves', () => {
    // They clicked the button; they are already looking at the screen.
    expect(emailFanOut('optimize_recommendation_ready', reachable)).toEqual({
      send: false,
      reason: 'never_emailed',
    })
  })

  it('sends no email of its own for the three kinds the monthly summary carries', () => {
    expect([...CARRIED_BY_MONTHLY_SUMMARY].sort()).toEqual([
      'merchant_task_created',
      'new_opportunities_found',
      'topic_held_by_gate',
    ])
    for (const type of CARRIED_BY_MONTHLY_SUMMARY) {
      expect(emailFanOut(type, reachable)).toEqual({
        send: false,
        reason: 'carried_by_monthly_summary',
      })
    }
  })

  it('sends the pipeline-stopping kinds whatever the merchant has saved', () => {
    const opinionated: EmailAudience = {
      suppressed: false,
      preferences: { emailArticlePublished: false, emailDigestFrequency: 'off' },
    }
    for (const type of ['connection_lost_shopify', 'payment_failed', 'repair_needed'] as const) {
      expect(emailFanOut(type, opinionated)).toEqual({ send: true, state: 'queued' })
    }
  })

  it('holds a per-article email until the merchant asks for one', () => {
    expect(emailFanOut('article_published', reachable)).toEqual({ send: false, reason: 'turned_off' })
    expect(
      emailFanOut('article_published', {
        suppressed: false,
        preferences: { emailArticlePublished: true, emailDigestFrequency: 'off' },
      }),
    ).toEqual({ send: true, state: 'queued' })
  })

  it('sends the monthly summary to a merchant who has never opened settings', () => {
    expect(emailFanOut('monthly_summary_ready', reachable)).toEqual({ send: true, state: 'queued' })
  })

  it('stops the monthly summary once one-click unsubscribe has written `off`', () => {
    expect(
      emailFanOut('monthly_summary_ready', {
        suppressed: false,
        preferences: { emailArticlePublished: true, emailDigestFrequency: 'off' },
      }),
    ).toEqual({ send: false, reason: 'turned_off' })
  })

  it('records a suppressed address rather than silently dropping it', () => {
    // A row in `suppressed` is the answer to "why did I not get that email".
    expect(emailFanOut('payment_failed', { suppressed: true })).toEqual({
      send: true,
      state: 'suppressed',
    })
  })

  it('still sends account-security mail to a suppressed address', () => {
    expect(emailFanOut('payment_failed', { suppressed: true, securityEmail: true })).toEqual({
      send: true,
      state: 'queued',
    })
  })

  it('never decides an email without a matrix row behind it', () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(() => emailFanOut(type, reachable)).not.toThrow()
    }
  })
})

describe('preferences', () => {
  it('reads no preference at all for a kind that cannot be turned off', () => {
    const off: EmailAudience = {
      suppressed: false,
      preferences: { emailArticlePublished: false, emailDigestFrequency: 'off' },
    }
    const notToggleable = NOTIFICATION_TYPES.filter((t) => !notificationChannels(t).toggleable)
    for (const type of notToggleable) expect(emailWanted(type, off)).toBe(true)
  })

  it('offers an unsubscribe link on exactly the kinds a merchant may turn off', () => {
    const unsubscribable = NOTIFICATION_TYPES.filter((t: NotificationType) => needsUnsubscribe(t))
    expect([...unsubscribable].sort()).toEqual(['article_published', 'monthly_summary_ready'])
  })

  it('states every column when a preference row is first written', () => {
    // A merchant switching per-article email on must not silently lose the
    // monthly summary because the other column defaulted to off underneath them.
    expect(defaultNotificationPreferences()).toEqual({
      emailArticlePublished: false,
      emailDigestFrequency: 'weekly',
    })
  })
})

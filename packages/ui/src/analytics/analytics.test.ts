import { describe, expect, it } from 'vitest'
import { RecordingUiAnalytics, noopUiAnalytics, UI_EVENT_NAMES } from './index'

describe('the events a screen may report', () => {
  it('names them in snake_case, matching the server-side taxonomy', () => {
    for (const name of UI_EVENT_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/)
    }
  })

  it('lists each event once', () => {
    expect(new Set(UI_EVENT_NAMES).size).toBe(UI_EVENT_NAMES.length)
  })
})

describe('analytics switched off is a working product', () => {
  it('does nothing and throws nothing', () => {
    expect(() =>
      noopUiAnalytics.capture('banner_dismissed', { banner: 'limited_intelligence' }),
    ).not.toThrow()
  })
})

describe('the test double', () => {
  it('remembers what a screen reported', () => {
    const analytics = new RecordingUiAnalytics()
    analytics.capture('opportunity_viewed', {
      opportunity_id: 'abc',
      signal_type: 'striking_distance',
      recommended_action: 'OPTIMIZE',
    })
    analytics.capture('banner_dismissed', { banner: 'gsc_reconnect' })

    expect(analytics.events).toHaveLength(2)
    expect(analytics.named('opportunity_viewed')[0]?.properties).toEqual({
      opportunity_id: 'abc',
      signal_type: 'striking_distance',
      recommended_action: 'OPTIMIZE',
    })
  })

  it('copies the properties rather than holding the caller\'s object', () => {
    const analytics = new RecordingUiAnalytics()
    const properties = { banner: 'vacation_mode' }
    analytics.capture('banner_dismissed', properties)
    properties.banner = 'changed'
    expect(analytics.events[0]?.properties).toEqual({ banner: 'vacation_mode' })
  })
})

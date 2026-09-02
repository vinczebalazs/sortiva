import { describe, expect, it } from 'vitest'
import {
  acceptsValue,
  allEventDefinitions,
  checkEventProperties,
  PROPERTY_KINDS,
  RecordingUiAnalytics,
  noopUiAnalytics,
  UI_EVENT_NAMES,
} from './index'

/**
 * The four values that reached the analytics vendor when the server-side
 * wrapper was tested against this rule (`docs/audits/false-confidence.md`,
 * finding 9). The wrapper redacted the token and passed the other three
 * through. Nothing a screen sends may carry any of them.
 */
const WHAT_MUST_NEVER_REACH_THE_VENDOR = [
  'Ten Ways To Style A Merino Base Layer',
  'Merino wool regulates temperature across a wide range...',
  'You are an SEO writer. Write 1200 words about...',
  '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',
]

/** Words that name a piece of the merchant's content rather than an identifier or a count. */
const CONTENT_SHAPED_NAMES = [
  'title',
  'body',
  'text',
  'content',
  'prompt',
  'token',
  'headline',
  'summary',
  'description',
  'excerpt',
  'keyword',
  'query',
  'url',
  'slug',
  'label',
  'message',
]

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

describe('no event can be defined so that it carries store content', () => {
  it('gives every declared property one of the four kinds, and there is no kind for text', () => {
    for (const [event, properties] of allEventDefinitions()) {
      expect(Object.keys(properties).length, `${event} declares no properties`).toBeGreaterThan(0)
      for (const [property, kind] of Object.entries(properties)) {
        expect(PROPERTY_KINDS, `${event}.${property}`).toContain(kind)
      }
    }
  })

  it('refuses an article title, an article body, a prompt or a token in every kind there is', () => {
    for (const kind of PROPERTY_KINDS) {
      for (const leaked of WHAT_MUST_NEVER_REACH_THE_VENDOR) {
        expect(acceptsValue(kind, leaked), `${kind} accepted ${JSON.stringify(leaked)}`).toBe(false)
      }
    }
  })

  it('names no property after a piece of the merchant’s content', () => {
    for (const [event, properties] of allEventDefinitions()) {
      for (const property of Object.keys(properties)) {
        const offending = CONTENT_SHAPED_NAMES.filter((word) => property.includes(word))
        expect(offending, `${event}.${property} is named after content`).toEqual([])
      }
    }
  })
})

describe('a property an event does not declare never leaves the browser', () => {
  it('drops it, and says it dropped it', () => {
    const checked = checkEventProperties('override_confirmed', {
      article_id: 'art-1',
      failing_criteria_count: 2,
      // A plausible thing for a hurried call site to attach: the draft's own title.
      article_title: 'Ten Ways To Style A Merino Base Layer',
    })

    expect(checked.properties).toEqual({ article_id: 'art-1', failing_criteria_count: 2 })
    expect(checked.rejected).toEqual([{ key: 'article_title', reason: 'undeclared' }])
  })

  it('drops a declared property whose value is text rather than a name', () => {
    const checked = checkEventProperties('opportunity_viewed', {
      opportunity_id: 'opp-1',
      signal_type: 'striking_distance',
      recommended_action: 'Rewrite the merino base layer guide for autumn',
    })

    expect(checked.properties).toEqual({
      opportunity_id: 'opp-1',
      signal_type: 'striking_distance',
    })
    expect(checked.rejected).toEqual([{ key: 'recommended_action', reason: 'wrong_shape' }])
  })

  it('is refused by the compiler too, so the drop is a second line of defence', () => {
    const analytics = new RecordingUiAnalytics()
    analytics.capture('banner_dismissed', {
      banner: 'gsc_reconnect',
      // @ts-expect-error — `banner_dismissed` declares one property; a free-text
      // field is not one of them. Remove the guard and this line stops erroring,
      // which fails `pnpm typecheck`.
      banner_text: 'Reconnect Search Console to keep your ranking data fresh',
    })

    expect(analytics.events[0]?.properties).toEqual({ banner: 'gsc_reconnect' })
    expect(analytics.rejected).toEqual([{ key: 'banner_text', reason: 'undeclared' }])
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

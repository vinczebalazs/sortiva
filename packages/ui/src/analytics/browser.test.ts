import { describe, expect, it } from 'vitest'
import { accountAttribution, previewAttribution } from '@sortiva/core/contracts/analytics'
import {
  browserAnalyticsInitOptions,
  createPosthogUiAnalytics,
  DEFAULT_POSTHOG_HOST,
  sessionReplay,
  SESSION_REPLAY_VIEWS,
  storeDataViews,
  viewContent,
  type PosthogBrowserClient,
} from './index'

interface Sent {
  event: string
  properties: Record<string, unknown> | undefined
}

function fakeVendorClient() {
  const sent: Sent[] = []
  const identified: string[] = []
  let recordingStopped = 0
  const client: PosthogBrowserClient = {
    identify: (distinctId) => void identified.push(distinctId),
    capture: (event, properties) => void sent.push({ event, properties }),
    stopSessionRecording: () => void (recordingStopped += 1),
  }
  return { client, sent, identified, stops: () => recordingStopped }
}

describe('an event a screen reports reaches the vendor', () => {
  it('carries the account and the domain group the server-side wrapper applies', () => {
    const { client, sent } = fakeVendorClient()
    const analytics = createPosthogUiAnalytics(client, accountAttribution('acc-1', 'example.com'))

    analytics.capture('opportunity_viewed', {
      opportunity_id: 'opp-9',
      signal_type: 'striking_distance',
      recommended_action: 'OPTIMIZE',
    })

    expect(sent).toEqual([
      {
        event: 'opportunity_viewed',
        properties: {
          account_id: 'acc-1',
          opportunity_id: 'opp-9',
          signal_type: 'striking_distance',
          recommended_action: 'OPTIMIZE',
          $groups: { domain: 'example.com' },
        },
      },
    ])
  })

  it('sends no domain group before a domain is claimed, rather than an empty one', () => {
    const { client, sent } = fakeVendorClient()
    const analytics = createPosthogUiAnalytics(client, accountAttribution('acc-1'))

    analytics.capture('banner_dismissed', { banner: 'connect_store' })

    expect(sent[0]?.properties).toEqual({ account_id: 'acc-1', banner: 'connect_store' })
  })

  it('drops a property the event does not declare on the way to the vendor', () => {
    const { client, sent } = fakeVendorClient()
    const analytics = createPosthogUiAnalytics(client, accountAttribution('acc-1', 'example.com'))

    analytics.capture('override_confirmed', {
      article_id: 'art-4',
      failing_criteria_count: 1,
      article_title: 'Ten Ways To Style A Merino Base Layer',
    } as never)

    expect(sent[0]?.properties).toEqual({
      account_id: 'acc-1',
      article_id: 'art-4',
      failing_criteria_count: 1,
      $groups: { domain: 'example.com' },
    })
  })

  it('does not take a screen down when the vendor throws', () => {
    const client: PosthogBrowserClient = {
      identify: () => {},
      capture: () => {
        throw new Error('network is down')
      },
      stopSessionRecording: () => {},
    }
    const analytics = createPosthogUiAnalytics(client, accountAttribution('acc-1'))

    expect(() => analytics.capture('banner_dismissed', { banner: 'gsc_reconnect' })).not.toThrow()
  })

  it('keeps preview traffic out of the domain group, the same way the server does', () => {
    const { client, sent } = fakeVendorClient()
    const analytics = createPosthogUiAnalytics(client, previewAttribution('nike.com'))

    analytics.capture('banner_dismissed', { banner: 'preview_ready' })

    expect(sent[0]?.properties).toEqual({ target_domain: 'nike.com', banner: 'preview_ready' })
  })
})

describe('the vendor library does nothing on its own', () => {
  const options = browserAnalyticsInitOptions('/dashboard')

  it('records no session, on a view showing store data', () => {
    expect(options.disable_session_recording).toBe(true)
  })

  it('captures no clicks by itself, which is what would carry product text', () => {
    expect(options.autocapture).toBe(false)
    expect(options.rageclick).toBe(false)
  })

  it('emits no page views, so the server-side funnel is not duplicated from the browser', () => {
    expect(options.capture_pageview).toBe(false)
    expect(options.capture_pageleave).toBe(false)
    expect(options.capture_performance).toBe(false)
  })

  it('shows the merchant nothing we did not write', () => {
    expect(options.disable_surveys).toBe(true)
  })

  it('defaults to the same host the server-side wrapper uses', () => {
    expect(options.api_host).toBe(DEFAULT_POSTHOG_HOST)
    expect(browserAnalyticsInitOptions('/signin', 'https://eu.example.test').api_host).toBe(
      'https://eu.example.test',
    )
  })
})

describe('session replay on a view that renders store data', () => {
  it('is off on every one of them', () => {
    const storeData = storeDataViews()
    expect(storeData.length).toBeGreaterThan(0)
    for (const route of storeData) {
      expect(sessionReplay(route), route).toBe('off')
      expect(browserAnalyticsInitOptions(route).disable_session_recording, route).toBe(true)
    }
  })

  it('stays off even when someone switches it on for that exact view', () => {
    for (const route of storeDataViews()) {
      expect(sessionReplay(route, [route]), route).toBe('off')
    }
  })

  it('is off on a view nobody has classified, because unclassified means unchecked', () => {
    expect(viewContent('/some-screen-added-tomorrow')).toBe('store_data')
    expect(sessionReplay('/some-screen-added-tomorrow', ['/some-screen-added-tomorrow'])).toBe('off')
  })

  it('is switched on for nothing at all today', () => {
    expect(SESSION_REPLAY_VIEWS).toEqual([])
  })
})

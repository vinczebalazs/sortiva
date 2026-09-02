import { afterEach, describe, expect, it } from 'vitest'
import { MockPosthogCapture } from '@sortiva/providers'
import { accountAttribution } from '../contracts/analytics'
import { initAppServices, resetAppServices } from '../runtime/services'
import { silentLogger } from './logger'
import { registerSecret } from './scrub'
import { reportCrash, SYSTEM_ACTOR } from './crash'

/**
 * T-OPS: `captureException` was implemented and had no caller anywhere, so an
 * unhandled error went to stdout and nowhere else. These assert the call, not
 * the wiring.
 */

afterEach(() => {
  resetAppServices()
})

function withMockAnalytics(): MockPosthogCapture {
  const analytics = new MockPosthogCapture()
  initAppServices(() => ({ analytics }))
  return analytics
}

describe('reportCrash', () => {
  it('hands the error to the analytics client', () => {
    const analytics = withMockAnalytics()
    const boom = new Error('the step blew up')

    reportCrash(boom, {
      attribution: accountAttribution('acct-1', 'example.com'),
      properties: { step: 'catalog_sync', error_class: 'unclassified' },
      logger: silentLogger,
    })

    expect(analytics.exceptions).toHaveLength(1)
    expect((analytics.exceptions[0]!.error as Error).message).toBe(boom.message)
    expect(analytics.exceptions[0]!.capture.distinctId).toBe('acct-1')
    expect(analytics.exceptions[0]!.capture.groups).toEqual({ domain: 'example.com' })
    expect(analytics.exceptions[0]!.capture.properties).toMatchObject({
      step: 'catalog_sync',
      error_class: 'unclassified',
    })
  })

  it('attributes a crash with no account to the system actor, with no domain group', () => {
    const analytics = withMockAnalytics()

    reportCrash(new Error('nobody owns this'), { logger: silentLogger })

    expect(analytics.exceptions[0]!.capture.distinctId).toBe(SYSTEM_ACTOR)
    expect(analytics.exceptions[0]!.capture.groups).toEqual({})
  })

  it('redacts a secret that reached the error message', () => {
    const analytics = withMockAnalytics()
    // A crash report must not be the way a token leaves the process. The
    // scrubber sits inside the capture wrapper, so this asserts the path a real
    // crash takes rather than a scrubber called by hand.
    registerSecret('shpat_supersecrettoken')

    reportCrash(new Error('Shopify rejected shpat_supersecrettoken'), { logger: silentLogger })

    const reported = analytics.exceptions[0]!.error as Error
    expect(reported.message).not.toContain('supersecrettoken')
  })

  it('does not throw when the process never built its service bundle', () => {
    expect(() => reportCrash(new Error('early'), { logger: silentLogger })).not.toThrow()
  })

  it('does not throw when the analytics client itself fails', () => {
    initAppServices(() => ({
      analytics: {
        capture: () => {},
        captureAiGeneration: () => {},
        captureSeoRequest: () => {},
        captureException: () => {
          throw new Error('the sink is down')
        },
        flush: async () => {},
        shutdown: async () => {},
      },
    }))

    expect(() => reportCrash(new Error('boom'), { logger: silentLogger })).not.toThrow()
  })
})

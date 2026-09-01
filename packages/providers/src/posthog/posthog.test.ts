import { describe, expect, it, vi } from 'vitest'
import { accountAttribution, createLogger, previewAttribution } from '@sortiva/core'
import { MockPosthogCapture, PosthogServerCapture, UnrecordedCapture } from './index'

/**
 * main §14.7's two attribution rules, asserted on the live wrapper rather than
 * on the double: "everything is groupable by domain", and "the domain group is
 * reserved for claimed domains — preview events carry `target_domain` as a plain
 * property instead".
 */

function fakeClient() {
  return { capture: vi.fn(), captureException: vi.fn(), flush: vi.fn(), shutdown: vi.fn() }
}

describe('PosthogServerCapture', () => {
  it('attaches the domain group to an account event', () => {
    const client = fakeClient()
    new PosthogServerCapture({ client: client as never }).capture({
      event: 'domain_claimed',
      attribution: accountAttribution('acc-1', 'example.com'),
    })

    const [call] = client.capture.mock.calls as [[{ groups: unknown; distinctId: string }]]
    expect(call[0].groups).toEqual({ domain: 'example.com' })
    expect(call[0].distinctId).toBe('acc-1')
  })

  it('gives preview events a target_domain property and no group', () => {
    const client = fakeClient()
    new PosthogServerCapture({ client: client as never }).capture({
      event: 'preview_served',
      attribution: previewAttribution('nike.com'),
      properties: { cache_hit: true },
    })

    const [call] = client.capture.mock.calls as [[{ groups: unknown; properties: Record<string, unknown> }]]
    expect(call[0].groups).toEqual({})
    expect(call[0].properties.target_domain).toBe('nike.com')
    expect(call[0].properties.account_id).toBeUndefined()
  })

  it('omits the group before a domain is claimed, rather than inventing one', () => {
    const client = fakeClient()
    new PosthogServerCapture({ client: client as never }).capture({
      event: 'signup_completed',
      attribution: accountAttribution('acc-2'),
    })

    const [call] = client.capture.mock.calls as [[{ groups: unknown }]]
    expect(call[0].groups).toEqual({})
  })

  it('scrubs secrets out of properties before they reach the wire', () => {
    const client = fakeClient()
    new PosthogServerCapture({ client: client as never }).capture({
      event: 'shopify_oauth_granted',
      attribution: accountAttribution('acc-1', 'example.com'),
      properties: { access_token: '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', scopes: 4 },
    })

    const [call] = client.capture.mock.calls as [[{ properties: Record<string, unknown> }]]
    expect(call[0].properties.access_token).toBe('[redacted]')
    expect(call[0].properties.scopes).toBe(4)
  })

  it('captures nothing at all when no project key is configured — but says so', () => {
    // Audit `docs/audits/T0.5.md` finding 6: this used to degrade to silence
    // with no error, no warning and no log line, so a deploy missing the key
    // spent real money invisibly. It still degrades (local dev has no project),
    // and it now announces itself once at construction.
    const lines: string[] = []
    const capture = new PosthogServerCapture({
      apiKey: undefined,
      enabled: false,
      logger: createLogger({ sink: (line) => lines.push(line), minLevel: 'debug' }),
    })

    expect(() =>
      capture.capture({ event: 'preview_requested', attribution: previewAttribution('x.com') }),
    ).not.toThrow()
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: 'warn',
      msg: 'posthog_capture_disabled',
    })
  })
})

describe('UnrecordedCapture', () => {
  it('is the way a caller says "no telemetry here" out loud', async () => {
    const capture = new UnrecordedCapture()
    expect(() =>
      capture.capture({ event: 'preview_requested', attribution: previewAttribution('x.com') }),
    ).not.toThrow()
    await expect(capture.flush()).resolves.toBeUndefined()
    await expect(capture.shutdown()).resolves.toBeUndefined()
  })
})

describe('MockPosthogCapture', () => {
  it('totals LLM and DataForSEO spend, which is the cost-per-domain number', () => {
    const capture = new MockPosthogCapture()
    const attribution = accountAttribution('acc-1', 'example.com')

    capture.captureAiGeneration({
      attribution,
      callType: 'distill',
      promptVersion: 'distill.v1',
      modelId: 'claude-haiku-4-5',
      inputTokens: 1000,
      outputTokens: 200,
      latencyMs: 400,
      usdCost: 0.002,
      cacheHit: false,
    })
    capture.captureSeoRequest({
      attribution,
      endpoint: 'serp/google/organic/live/advanced',
      billable: true,
      cacheHit: false,
      usdCost: 0.002,
    })

    expect(capture.totalUsdCost).toBeCloseTo(0.004, 6)
    expect(capture.of('$ai_generation')[0]!.properties.$ai_model).toBe('claude-haiku-4-5')
  })
})

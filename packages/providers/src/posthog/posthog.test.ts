import { describe, expect, it, vi } from 'vitest'
import { accountAttribution, createLogger, previewAttribution } from '@sortiva/core'
import { MockPosthogCapture, PosthogServerCapture, UnrecordedCapture } from './index'

/**
 * The two attribution rules, asserted on the live wrapper rather than
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

  it('drops a credential nobody declared, rather than sending it redacted', () => {
    // This used to arrive as `access_token: '[redacted]'`. A redacted secret is
    // still a property nobody declared, and the same open bag that carried it
    // would have carried an article body untouched.
    const client = fakeClient()
    new PosthogServerCapture({ client: client as never }).capture({
      event: 'article_published',
      attribution: accountAttribution('acc-1', 'example.com'),
      properties: { access_token: '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', article_id: 'art-9' },
    })

    const [call] = client.capture.mock.calls as [[{ properties: Record<string, unknown> }]]
    expect(call[0].properties.access_token).toBeUndefined()
    expect(call[0].properties.article_id).toBe('art-9')
  })

  it('sends nothing a merchant wrote, on any of the four ways in', () => {
    const client = fakeClient()
    const capture = new PosthogServerCapture({ client: client as never })
    const attribution = accountAttribution('acc-1', 'example.com')
    const draft = 'Merino wool regulates temperature across a wide range...'

    capture.capture({
      event: 'article_published',
      attribution,
      properties: { article_id: 'art-1', article_body: draft },
    })
    capture.captureAiGeneration({
      attribution,
      callType: 'draft',
      promptVersion: 'draft.v3',
      modelId: 'claude-sonnet-4-5',
      inputTokens: 10,
      outputTokens: 20,
      latencyMs: 30,
      usdCost: 0.01,
      cacheHit: false,
      properties: { completion: draft },
    })
    capture.captureSeoRequest({
      attribution,
      endpoint: 'serp/google/organic/live/advanced',
      billable: true,
      cacheHit: false,
      usdCost: 0.002,
      properties: { keyword: 'merino base layer' },
    })
    capture.captureException(new Error('boom'), attribution, { draft_body: draft })

    const sent = [
      ...client.capture.mock.calls.map((call) => (call as [{ properties: unknown }])[0].properties),
      ...client.captureException.mock.calls.map((call) => (call as [unknown, string, unknown])[2]),
    ]
    expect(sent).toHaveLength(4)
    expect(JSON.stringify(sent)).not.toContain('Merino wool')
    expect(JSON.stringify(sent)).not.toContain('merino base layer')
  })

  it('still scrubs the message of a captured error, which no table can check', () => {
    // An exception's message and stack are not properties. The event table
    // cannot see inside them, so the credential scrubber is the only thing
    // between a thrown string and the vendor — and it is still wired.
    const client = fakeClient()
    new PosthogServerCapture({ client: client as never }).captureException(
      new Error('shopify rejected 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'),
      accountAttribution('acc-1', 'example.com'),
    )

    const [call] = client.captureException.mock.calls as [[Error, string, unknown]]
    expect(call[0].message).toContain('[redacted]')
    expect(call[0].message).not.toContain('shpat_a1b2c3d4e5f6')
  })

  it('captures nothing at all when no project key is configured — but says so', () => {
    // this used to degrade to silence
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
  it('runs the same event table as the live wrapper, so a test asserting the rule is asserting production', () => {
    const capture = new MockPosthogCapture()
    capture.capture({
      event: 'article_published',
      attribution: accountAttribution('acc-1', 'example.com'),
      properties: {
        article_id: 'art-1',
        article_title: 'Ten Ways To Style A Merino Base Layer',
      },
    })

    expect(capture.of('article_published')[0]!.properties).toEqual({
      account_id: 'acc-1',
      article_id: 'art-1',
    })
    expect(capture.rejected).toEqual([{ key: 'article_title', reason: 'undeclared' }])
  })

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

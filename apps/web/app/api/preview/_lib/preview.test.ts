import { describe, expect, it } from 'vitest'
import {
  OutboundScrapeCap,
  PreviewRateLimiter,
  previewResponseSchema,
  type LlmClient,
  type LlmRequest,
  type LlmResult,
  type PreviewCacheEntry,
  type PreviewCacheStore,
  type PreviewDependencies,
} from '@sortiva/core'
import { MockPageFetcher, MockPosthogCapture, MockTurnstile } from '@sortiva/providers'
import { clientIpOf, makePreviewHandler } from './handler'

/**
 * `POST /api/preview` at the HTTP level. The funnel
 * behaviour itself is proved in `packages/core/src/preview/preview.test.ts`;
 * what is asserted here is the wire contract — which status code each outcome
 * produces, and that a 200 body matches the frozen response schema.
 */

const HOMEPAGE = `<!doctype html><html><head>
<title>Alpine Trail Co. — Trail running shoes</title>
<meta name="description" content="Trail running shoes and packs built for wet British ground, in three widths.">
</head><body><h1>Built for wet ground</h1>
<p>We make trail shoes in three widths and carry packs to match. Everything is designed in Cumbria and tested on the fells through a British winter.</p></body></html>`

const SUMMARY = 'Alpine Trail Co. sells trail running shoes and packs for wet ground in three widths.'

class StubLlm implements LlmClient {
  constructor(private readonly text: string = SUMMARY) {}
  async complete<T = unknown>(request: LlmRequest): Promise<LlmResult<T>> {
    return {
      output: this.text as T,
      text: this.text,
      modelId: 'claude-haiku-4-5',
      promptVersion: request.promptVersion,
      cacheHit: false,
      usage: { inputTokens: 80, outputTokens: 30, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      usdCost: 0.0002,
      latencyMs: 5,
      attempts: 1,
    }
  }
}

class MemoryCache implements PreviewCacheStore {
  readonly rows = new Map<string, PreviewCacheEntry>()
  async read(domain: string) {
    return this.rows.get(domain)
  }
  async write(entry: PreviewCacheEntry & { expiresAt: Date }) {
    this.rows.set(entry.domain, entry)
  }
}

function deps(overrides: Partial<PreviewDependencies> = {}): PreviewDependencies {
  return {
    cache: new MemoryCache(),
    fetcher: new MockPageFetcher().on('https://alpinetrail.co/', HOMEPAGE),
    challenge: new MockTurnstile(),
    flags: { isPreviewPaused: async () => false },
    llm: new StubLlm(),
    prompt: { version: 'preview.v1', text: 'SYSTEM' },
    capture: new MockPosthogCapture(),
    rateLimiter: new PreviewRateLimiter(),
    scrapeCap: new OutboundScrapeCap(),
    ...overrides,
  }
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://sortiva.com/api/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const VALID = { url: 'alpinetrail.co', turnstileToken: 'tok' }

describe('POST /api/preview', () => {
  it('answers 200 with a body matching the frozen response schema', async () => {
    const handler = makePreviewHandler({ deps: deps() })
    const response = await handler(post(VALID))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(previewResponseSchema.parse(body)).toEqual({
      domain: 'alpinetrail.co',
      summary: SUMMARY,
      cacheHit: false,
      generic: false,
    })
  })

  it('answers 429 with the rate_limited code and a Retry-After header', async () => {
    const handler = makePreviewHandler({ deps: deps() })
    for (let i = 0; i < 5; i += 1) {
      expect((await handler(post(VALID))).status).toBe(200)
    }

    const sixth = await handler(post(VALID))

    expect(sixth.status).toBe(429)
    expect(sixth.headers.get('retry-after')).toMatch(/^\d+$/)
    expect(await sixth.json()).toMatchObject({ error: { code: 'rate_limited' } })
  })

  it('rate-limits per address, so one abuser does not close the funnel', async () => {
    const handler = makePreviewHandler({ deps: deps() })
    for (let i = 0; i < 6; i += 1) await handler(post(VALID))
    const other = await handler(post(VALID, { 'x-forwarded-for': '198.51.100.20' }))
    expect(other.status).toBe(200)
  })

  it('answers 403 when the Turnstile check fails', async () => {
    const handler = makePreviewHandler({ deps: deps({ challenge: new MockTurnstile().reject() }) })
    const response = await handler(post(VALID))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'turnstile_failed' } })
  })

  it('answers 422 for a body that is not JSON, and for a missing token', async () => {
    const handler = makePreviewHandler({ deps: deps() })
    expect((await handler(post('{not json'))).status).toBe(422)
    expect((await handler(post({ url: 'alpinetrail.co' }))).status).toBe(422)
  })

  it('answers 422 for an unusable address', async () => {
    const handler = makePreviewHandler({ deps: deps() })
    const response = await handler(post({ ...VALID, url: 'not a website' }))
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_url' } })
  })

  it('answers 200 with the generic card when the spend trip is on (main §14.5)', async () => {
    const fetcher = new MockPageFetcher().on('https://alpinetrail.co/', HOMEPAGE)
    const handler = makePreviewHandler({
      deps: deps({ fetcher, flags: { isPreviewPaused: async () => true } }),
    })

    const response = await handler(post(VALID))

    expect(response.status).toBe(200)
    expect(previewResponseSchema.parse(await response.json())).toEqual({
      domain: 'alpinetrail.co',
      summary: null,
      cacheHit: false,
      generic: true,
    })
    expect(fetcher.callCount).toBe(0)
  })

  it('answers 200 with the generic card when the site cannot be read', async () => {
    const handler = makePreviewHandler({ deps: deps({ fetcher: new MockPageFetcher() }) })
    const response = await handler(post(VALID))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ summary: null, generic: true })
  })

  it('serves a second request for the same site from cache without fetching', async () => {
    const fetcher = new MockPageFetcher().on('https://alpinetrail.co/', HOMEPAGE)
    const handler = makePreviewHandler({ deps: deps({ fetcher }) })

    await handler(post(VALID))
    const second = await handler(post({ ...VALID, url: 'https://www.AlpineTrail.co/collections' }))

    expect(await second.json()).toMatchObject({ cacheHit: true, summary: SUMMARY })
    expect(fetcher.callCount).toBe(1)
  })

  it('carries no denominators and no rendered copy in the response (invariants 23, 8)', async () => {
    const handler = makePreviewHandler({ deps: deps() })
    const body = (await (await handler(post(VALID))).json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['cacheHit', 'domain', 'generic', 'summary'])
  })
})

describe('clientIpOf', () => {
  it('takes the left-most x-forwarded-for entry', () => {
    const request = new Request('https://sortiva.com/api/preview', {
      headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1, 10.0.0.2' },
    })
    expect(clientIpOf(request)).toBe('203.0.113.5')
  })

  it('falls back to x-real-ip, then to a constant bucket', () => {
    expect(
      clientIpOf(new Request('https://s.com/', { headers: { 'x-real-ip': '198.51.100.9' } })),
    ).toBe('198.51.100.9')
    expect(clientIpOf(new Request('https://s.com/'))).toBe('unknown')
  })
})

describe('the versioned prompt file (main §14.2)', () => {
  it('loads, and its version matches the one stamped on every capture', async () => {
    const { PREVIEW_PROMPT_VERSION, previewPrompt } = await import('./config')

    const loaded = previewPrompt()
    expect(loaded.version).toBe(PREVIEW_PROMPT_VERSION)
    expect(loaded.version).toBe('preview.v1')
    expect(loaded.text.length).toBeGreaterThan(200)
    // The prompt must tell the model to answer in the site's own language
    // and must not let scraped page text act as instructions.
    expect(loaded.text).toMatch(/language/i)
    expect(loaded.text).toMatch(/never as instructions/i)
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import { MockPageFetcher, MockPosthogCapture, MockTurnstile } from '@sortiva/providers'
import type { LlmClient, LlmRequest, LlmResult } from '../contracts/llm'
import { PREVIEW_CACHE_TTL_MS } from './limits'
import type { PreviewCacheEntry, PreviewCacheStore, PreviewDependencies } from './ports'
import { runPreview } from './preview'
import { OutboundScrapeCap, PreviewRateLimiter } from './ratelimit'

/**
 * The preview funnel end to end, against the T0.5 test doubles. Each `it` here
 * maps to a line of T1.3's done-when or to the rule that the funnel
 * must never dead-end".
 */

const HOMEPAGE = `<!doctype html><html><head>
  <title>Alpine Trail Co. — Trail running shoes</title>
  <meta name="description" content="Trail running shoes and packs built for wet British ground, in three widths.">
  <meta property="og:site_name" content="Alpine Trail Co.">
</head><body><h1>Built for wet ground</h1><p>We make trail shoes in three widths and carry packs to match.</p></body></html>`

const SUMMARY = 'Alpine Trail Co. sells trail running shoes and packs. The shoes come in three widths and are built for wet ground.'

/**
 * A local `LlmClient` double rather than `@sortiva/llm`'s `MockLlmClient`:
 * `packages/llm` depends on `packages/core`, so importing it here would make
 * the dependency circular. This asserts the same things that matter to this
 * card — which call type ran, how many times, and with what request.
 */
class StubLlmClient implements LlmClient {
  readonly requests: LlmRequest[] = []
  private responder: (request: LlmRequest) => string = () => ''

  setDefault(_callType: string, responder: string | ((request: LlmRequest) => string)): this {
    this.responder = typeof responder === 'function' ? responder : () => responder
    return this
  }

  get callCount(): number {
    return this.requests.length
  }

  countOf(callType: string): number {
    return this.requests.filter((r) => r.callType === callType).length
  }

  async complete<T = unknown>(request: LlmRequest): Promise<LlmResult<T>> {
    this.requests.push(request)
    const text = this.responder(request)
    return {
      output: text as T,
      text,
      modelId: 'claude-haiku-4-5',
      promptVersion: request.promptVersion,
      cacheHit: false,
      usage: { inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      usdCost: 0.0003,
      latencyMs: 12,
      attempts: 1,
    }
  }
}

class InMemoryPreviewCache implements PreviewCacheStore {
  readonly rows = new Map<string, PreviewCacheEntry & { expiresAt: Date }>()
  readonly reads: string[] = []
  readonly writes: string[] = []

  constructor(private readonly now: () => Date = () => new Date()) {}

  async read(domain: string): Promise<PreviewCacheEntry | undefined> {
    this.reads.push(domain)
    const row = this.rows.get(domain)
    if (!row) return undefined
    if (row.expiresAt.getTime() <= this.now().getTime()) {
      this.rows.delete(domain)
      return undefined
    }
    return { domain: row.domain, summary: row.summary, fetchedAt: row.fetchedAt }
  }

  async write(entry: PreviewCacheEntry & { expiresAt: Date }): Promise<void> {
    this.writes.push(entry.domain)
    this.rows.set(entry.domain, entry)
  }
}

interface Harness {
  deps: PreviewDependencies
  cache: InMemoryPreviewCache
  fetcher: MockPageFetcher
  llm: StubLlmClient
  turnstile: MockTurnstile
  capture: MockPosthogCapture
  paused: { value: boolean }
  clock: { value: Date }
}

function harness(overrides: Partial<PreviewDependencies> = {}): Harness {
  const clock = { value: new Date('2026-09-01T10:00:00.000Z') }
  const now = () => clock.value
  const cache = new InMemoryPreviewCache(now)
  const fetcher = new MockPageFetcher().on('https://alpinetrail.co/', HOMEPAGE)
  const llm = new StubLlmClient().setDefault('preview', SUMMARY)
  const turnstile = new MockTurnstile()
  const capture = new MockPosthogCapture()
  const paused = { value: false }

  const deps: PreviewDependencies = {
    cache,
    fetcher,
    challenge: turnstile,
    flags: { isPreviewPaused: async () => paused.value },
    llm,
    prompt: { version: 'preview.v1', text: 'SYSTEM PROMPT' },
    capture,
    rateLimiter: new PreviewRateLimiter(),
    scrapeCap: new OutboundScrapeCap(),
    now,
    ...overrides,
  }
  return { deps, cache, fetcher, llm, turnstile, capture, paused, clock }
}

const REQUEST = { url: 'alpinetrail.co', turnstileToken: 'tok', clientIp: '203.0.113.9' }

describe('runPreview — the happy path', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('fetches, extracts, summarises and stores the card', async () => {
    const result = await runPreview(REQUEST, h.deps)

    expect(result).toMatchObject({
      kind: 'served',
      reason: 'summarised',
      card: { domain: 'alpinetrail.co', summary: SUMMARY, cacheHit: false, generic: false },
    })
    expect(h.fetcher.requested).toEqual(['https://alpinetrail.co/'])
    expect(h.llm.countOf('preview')).toBe(1)
    expect(h.cache.writes).toEqual(['alpinetrail.co'])
  })

  it('calls Haiku with call_type preview, the versioned prompt and a low temperature', async () => {
    let seen: { callType: string; promptVersion: string; temperature?: number; maxTokens: number } | undefined
    h.llm.setDefault('preview', (request) => {
      seen = {
        callType: request.callType,
        promptVersion: request.promptVersion,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
      }
      return SUMMARY
    })
    await runPreview(REQUEST, h.deps)

    expect(seen?.callType).toBe('preview')
    expect(seen?.promptVersion).toBe('preview.v1')
    expect(seen?.temperature).toBeLessThanOrEqual(0.3)
    expect(seen?.maxTokens).toBeLessThanOrEqual(150)
    // No explicit model override: the model registry binds call_type
    // `preview` to Haiku, and the wrapper resolves it. Overriding here would
    // route the preview onto whatever the caller felt like paying for.
    expect(h.llm.requests[0]?.model).toBeUndefined()
  })

  it('stores the row with a 7-day expiry (main §3.2)', async () => {
    await runPreview(REQUEST, h.deps)
    const row = h.cache.rows.get('alpinetrail.co')
    expect(row?.expiresAt.getTime()).toBe(h.clock.value.getTime() + PREVIEW_CACHE_TTL_MS)
  })

  it('verifies Turnstile before it fetches anything', async () => {
    await runPreview(REQUEST, h.deps)
    expect(h.turnstile.callCount).toBe(1)
    expect(h.turnstile.verified[0]).toEqual({ token: 'tok', remoteIp: '203.0.113.9' })
  })
})

describe('the cache is the primary cost control (main §3.2)', () => {
  it('a cache hit skips the scrape AND the LLM call entirely', async () => {
    const h = harness()
    await runPreview(REQUEST, h.deps)
    expect(h.fetcher.callCount).toBe(1)
    expect(h.llm.callCount).toBe(1)

    const second = await runPreview(REQUEST, h.deps)

    expect(second).toMatchObject({ kind: 'served', reason: 'cache' })
    expect(second).toHaveProperty('card.cacheHit', true)
    expect(second).toHaveProperty('card.summary', SUMMARY)
    // The two numbers that make the preview's cost model work.
    expect(h.fetcher.callCount).toBe(1)
    expect(h.llm.callCount).toBe(1)
  })

  it('different spellings of one site share a cache row', async () => {
    const h = harness()
    await runPreview(REQUEST, h.deps)
    const again = await runPreview({ ...REQUEST, url: 'HTTPS://WWW.AlpineTrail.co/pages/x' }, h.deps)
    expect(again).toMatchObject({ reason: 'cache' })
    expect(h.fetcher.callCount).toBe(1)
  })

  it('re-fetches once the 7-day row has expired', async () => {
    const h = harness()
    await runPreview(REQUEST, h.deps)
    h.clock.value = new Date(h.clock.value.getTime() + PREVIEW_CACHE_TTL_MS + 1000)
    const again = await runPreview(REQUEST, h.deps)
    expect(again).toMatchObject({ reason: 'summarised' })
    expect(h.fetcher.callCount).toBe(2)
  })
})

describe('the preview spend trip (main §14.5, invariant 17)', () => {
  it('serves the generic card on a miss without fetching or calling the model', async () => {
    const h = harness()
    h.paused.value = true

    const result = await runPreview(REQUEST, h.deps)

    expect(result).toMatchObject({
      kind: 'served',
      reason: 'preview_paused',
      card: { summary: null, generic: true, cacheHit: false },
    })
    expect(h.fetcher.callCount).toBe(0)
    expect(h.llm.callCount).toBe(0)
    expect(h.cache.writes).toEqual([])
  })

  it('still serves cache hits as normal while tripped', async () => {
    const h = harness()
    await runPreview(REQUEST, h.deps)
    h.paused.value = true

    const result = await runPreview(REQUEST, h.deps)

    expect(result).toMatchObject({
      kind: 'served',
      reason: 'cache',
      card: { summary: SUMMARY, generic: false, cacheHit: true },
    })
  })
})

describe('the funnel never dead-ends (main §3.3)', () => {
  it('an unreachable site gets the generic card, not an error', async () => {
    const h = harness({ fetcher: new MockPageFetcher() })
    const result = await runPreview(REQUEST, h.deps)
    expect(result).toMatchObject({ kind: 'served', reason: 'fetch_failed' })
    expect(result).toHaveProperty('card.generic', true)
  })

  it('an SSRF-blocked target gets the generic card, and is never summarised', async () => {
    const fetcher = new MockPageFetcher()
    const h = harness({ fetcher })
    const result = await runPreview(REQUEST, h.deps)
    expect(result).toMatchObject({ kind: 'served', reason: 'fetch_failed' })
    expect(h.llm.callCount).toBe(0)
  })

  it('a model failure gets the generic card', async () => {
    const h = harness()
    h.llm.setDefault('preview', () => {
      throw new Error('anthropic 529')
    })
    const result = await runPreview(REQUEST, h.deps)
    expect(result).toMatchObject({ kind: 'served', reason: 'summary_failed' })
    expect(h.cache.writes).toEqual([])
  })

  it('a degenerate one-word completion is treated as a failed summary', async () => {
    const h = harness()
    h.llm.setDefault('preview', 'Shoes.')
    const result = await runPreview(REQUEST, h.deps)
    expect(result).toMatchObject({ kind: 'served', reason: 'summary_failed' })
  })

  it('a generic card is never written to the cache, so a brief outage is not frozen for 7 days', async () => {
    const h = harness({ fetcher: new MockPageFetcher() })
    await runPreview(REQUEST, h.deps)
    expect(h.cache.rows.size).toBe(0)
  })

  it('a full outbound concurrency pool gets the generic card rather than a queue', async () => {
    const cap = new OutboundScrapeCap(1)
    cap.acquire()
    const h = harness({ scrapeCap: cap })
    const result = await runPreview(REQUEST, h.deps)
    expect(result).toMatchObject({ kind: 'served', reason: 'at_capacity' })
    expect(h.fetcher.callCount).toBe(0)
  })

  it('releases its concurrency slot even when the fetch throws', async () => {
    const cap = new OutboundScrapeCap(1)
    const h = harness({ fetcher: new MockPageFetcher(), scrapeCap: cap })
    await runPreview(REQUEST, h.deps)
    expect(cap.active).toBe(0)
  })
})

describe('the about-page fallback (main §3.3 step 4)', () => {
  it('fetches one about page when the homepage yields under ~200 chars of signal', async () => {
    const fetcher = new MockPageFetcher()
      .on('https://alpinetrail.co/', '<html><head><title>Shop</title></head><body></body></html>')
      .on(
        'https://alpinetrail.co/about',
        `<html><head><title>About Alpine Trail Co.</title><meta name="description" content="${'We make trail running shoes in Cumbria and have done since 2009, in three widths, for wet ground and long days out. '.repeat(2)}"></head><body></body></html>`,
      )
    const h = harness({ fetcher })

    const result = await runPreview(REQUEST, h.deps)

    expect(result).toMatchObject({ reason: 'summarised' })
    expect(fetcher.requested).toEqual(['https://alpinetrail.co/', 'https://alpinetrail.co/about'])
  })

  it('does not fetch an about page when the homepage was rich enough', async () => {
    const h = harness()
    await runPreview(REQUEST, h.deps)
    expect(h.fetcher.requested).toHaveLength(1)
  })

  it('tries the next about path when the first 404s, and stops after one success', async () => {
    const fetcher = new MockPageFetcher()
      .on('https://alpinetrail.co/', '<html><head><title>Shop</title></head><body></body></html>')
      .on(
        'https://alpinetrail.co/about-us',
        `<html><head><meta name="description" content="${'Independent trail running brand making shoes and packs for wet ground in three widths. '.repeat(3)}"></head><body></body></html>`,
      )
    const h = harness({ fetcher })

    await runPreview(REQUEST, h.deps)

    expect(fetcher.requested).toEqual([
      'https://alpinetrail.co/',
      'https://alpinetrail.co/about',
      'https://alpinetrail.co/about-us',
    ])
  })

  it('gives up after the about paths rather than crawling (there is no crawler in V1)', async () => {
    const fetcher = new MockPageFetcher().on(
      'https://alpinetrail.co/',
      '<html><head></head><body></body></html>',
    )
    const h = harness({ fetcher })
    await runPreview(REQUEST, h.deps)
    expect(fetcher.callCount).toBe(4) // homepage + the three about paths
  })
})

describe('rate limiting (main §3.2)', () => {
  it('refuses the sixth request from one IP inside a minute', async () => {
    const h = harness({ rateLimiter: new PreviewRateLimiter() })
    for (let i = 0; i < 5; i += 1) {
      expect(await runPreview(REQUEST, h.deps)).toMatchObject({ kind: 'served' })
    }
    const sixth = await runPreview(REQUEST, h.deps)
    expect(sixth).toMatchObject({ kind: 'rate_limited', scope: 'ip_minute' })
  })

  it('does not spend a Turnstile verification on a rate-limited caller', async () => {
    const h = harness()
    for (let i = 0; i < 5; i += 1) await runPreview(REQUEST, h.deps)
    const before = h.turnstile.callCount
    await runPreview(REQUEST, h.deps)
    expect(h.turnstile.callCount).toBe(before)
  })

  it('limits per IP, so one abuser does not close the funnel for everyone', async () => {
    const h = harness()
    for (let i = 0; i < 5; i += 1) await runPreview(REQUEST, h.deps)
    const other = await runPreview({ ...REQUEST, clientIp: '198.51.100.4' }, h.deps)
    expect(other).toMatchObject({ kind: 'served' })
  })
})

describe('Turnstile (main §3.2)', () => {
  it('a failed challenge never reaches the cache, the fetcher or the model', async () => {
    const h = harness()
    h.turnstile.reject(['invalid-input-response'])

    const result = await runPreview(REQUEST, h.deps)

    expect(result).toMatchObject({ kind: 'challenge_failed' })
    expect(h.cache.reads).toEqual([])
    expect(h.fetcher.callCount).toBe(0)
    expect(h.llm.callCount).toBe(0)
  })
})

describe('an unusable URL', () => {
  it('is refused before Turnstile, the cache or any fetch', async () => {
    const h = harness()
    const result = await runPreview({ ...REQUEST, url: 'not a website' }, h.deps)
    expect(result).toMatchObject({ kind: 'invalid_url' })
    expect(h.turnstile.callCount).toBe(0)
    expect(h.fetcher.callCount).toBe(0)
  })
})

describe('preview attribution (main §14.7, invariant 26)', () => {
  it('carries target_domain as a property and no domain group', async () => {
    const h = harness()
    await runPreview(REQUEST, h.deps)

    const events = h.capture.events.filter((e) =>
      ['preview_requested', 'preview_served'].includes(e.event),
    )
    expect(events.map((e) => e.event)).toEqual(['preview_requested', 'preview_served'])
    for (const event of events) {
      expect(event.properties.target_domain).toBe('alpinetrail.co')
      // The domain group is reserved for claimed domains: ten strangers
      // previewing nike.com is not Nike-the-account costing us money.
      expect(event.groups).toEqual({})
      expect(event.properties.account_id).toBeUndefined()
    }
  })

  it('marks a cache hit as a cache hit', async () => {
    const h = harness()
    await runPreview(REQUEST, h.deps)
    h.capture.reset()
    await runPreview(REQUEST, h.deps)

    expect(h.capture.of('preview_served')[0]?.properties).toMatchObject({
      cache_hit: true,
      generic: false,
    })
  })

  it('carries no page content, summary text or URL in any property', async () => {
    const h = harness()
    await runPreview(REQUEST, h.deps)
    const serialised = JSON.stringify(h.capture.events)
    expect(serialised).not.toContain('Built for wet ground')
    expect(serialised).not.toContain(SUMMARY)
    expect(serialised).not.toContain('https://')
  })

  it('emits nothing at all for a rate-limited or challenge-failed caller', async () => {
    const h = harness()
    h.turnstile.reject()
    await runPreview(REQUEST, h.deps)
    expect(h.capture.events).toEqual([])
  })
})

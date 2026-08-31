import { describe, expect, it, vi } from 'vitest'
import { InMemoryRequestCache, accountAttribution } from '@sortiva/core'
import { MockPosthogCapture } from '../posthog'
import { DataForSeoProvider, SeoRequestFailure } from './index'
import { seoCacheKey } from './key'
import { locationCodeFor } from './locations'
import { MockSeoDataProvider } from './mock'
import { DATAFORSEO_ENDPOINTS, priceFor } from './pricing'

/**
 * T0.5 done-when: "cache tests (crash-after-response replays without
 * re-billing); a cached call captures `usd_cost: 0` / `cache_hit: true`; mock
 * providers account cost."
 */

const LOCALE = { languageCode: 'da-DK', countryCode: 'DK' }
const ATTRIBUTION = accountAttribution('acc-1', 'example.dk')

function volumeResponse() {
  return {
    tasks: [
      {
        status_code: 20000,
        result: [{ keyword: 'løbesko', search_volume: 1300, competition: 0.4, cpc: 0.7 }],
      },
    ],
  }
}

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  ) as unknown as typeof fetch
}

describe('DataForSeoProvider', () => {
  it('writes the raw result to the cache before shaping it (invariant 20)', async () => {
    const cache = new InMemoryRequestCache()
    const provider = new DataForSeoProvider({
      login: 'u',
      password: 'p',
      cache,
      fetchImpl: fakeFetch(volumeResponse()),
    })

    await provider.keywordMetrics({ keywords: ['løbesko'], locale: LOCALE, attribution: ATTRIBUTION })

    expect(cache.writes).toHaveLength(1)
    expect(cache.writes[0]).toMatch(/^dataforseo:keywords_data/)
  })

  it('replays from cache after a crash, without a second billable call', async () => {
    const cache = new InMemoryRequestCache()
    const fetchImpl = fakeFetch(volumeResponse())
    const capture = new MockPosthogCapture()

    const first = new DataForSeoProvider({ login: 'u', password: 'p', cache, fetchImpl, capture })
    const before = await first.keywordMetrics({
      keywords: ['løbesko'],
      locale: LOCALE,
      attribution: ATTRIBUTION,
    })
    expect(before.meta.billable).toBe(true)
    expect(before.meta.usdCost).toBe(priceFor(DATAFORSEO_ENDPOINTS.keywordMetrics, 0))

    // The step crashed after the vendor answered; a new process retries it.
    const second = new DataForSeoProvider({ login: 'u', password: 'p', cache, fetchImpl, capture })
    const after = await second.keywordMetrics({
      keywords: ['løbesko'],
      locale: LOCALE,
      attribution: ATTRIBUTION,
    })

    expect(after.data).toEqual(before.data)
    expect(after.meta.cacheHit).toBe(true)
    expect(after.meta.billable).toBe(false)
    expect(after.meta.usdCost).toBe(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const events = capture.of('dataforseo_request')
    expect(events).toHaveLength(2)
    expect(events[1]!.properties).toMatchObject({ cache_hit: true, usd_cost: 0, billable: false })
    expect(events[1]!.groups).toEqual({ domain: 'example.dk' })
  })

  it('canonicalises params, so keyword order is not a second billable read', async () => {
    const cache = new InMemoryRequestCache()
    const fetchImpl = fakeFetch(volumeResponse())
    const provider = new DataForSeoProvider({ login: 'u', password: 'p', cache, fetchImpl })

    await provider.keywordMetrics({
      keywords: ['løbesko', 'trailsko'],
      locale: LOCALE,
      attribution: ATTRIBUTION,
    })
    await provider.keywordMetrics({
      keywords: ['Trailsko', ' løbesko '],
      locale: LOCALE,
      attribution: ATTRIBUTION,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('classifies a 429 as retryable and a 400 as terminal (main §14.3.5)', async () => {
    const retryable = new DataForSeoProvider({
      login: 'u',
      password: 'p',
      fetchImpl: fakeFetch({}, 429),
    })
    await expect(
      retryable.serpTop({ keyword: 'x', locale: LOCALE, depth: 10, attribution: ATTRIBUTION }),
    ).rejects.toMatchObject({ retryable: true, errorClass: 'dataforseo_upstream' })

    const terminal = new DataForSeoProvider({
      login: 'u',
      password: 'p',
      fetchImpl: fakeFetch({}, 400),
    })
    await expect(
      terminal.serpTop({ keyword: 'x', locale: LOCALE, depth: 10, attribution: ATTRIBUTION }),
    ).rejects.toMatchObject({ retryable: false, errorClass: 'dataforseo_bad_request' })
  })

  it('treats a task-level error inside a 200 body as a failure', async () => {
    const provider = new DataForSeoProvider({
      login: 'u',
      password: 'p',
      fetchImpl: fakeFetch({ tasks: [{ status_code: 40501, status_message: 'invalid field' }] }),
    })
    await expect(
      provider.keywordMetrics({ keywords: ['x'], locale: LOCALE, attribution: ATTRIBUTION }),
    ).rejects.toBeInstanceOf(SeoRequestFailure)
  })

  it('refuses to run unconfigured rather than silently returning nothing', async () => {
    const provider = new DataForSeoProvider({ login: '', password: '' })
    await expect(
      provider.keywordMetrics({ keywords: ['x'], locale: LOCALE, attribution: ATTRIBUTION }),
    ).rejects.toMatchObject({ errorClass: 'dataforseo_unconfigured', retryable: false })
  })
})

describe('location codes', () => {
  it('maps a country to 2000 + its ISO-3166 numeric code', () => {
    expect(locationCodeFor('US')).toBe(2840)
    expect(locationCodeFor('de')).toBe(2276)
    expect(locationCodeFor('DK')).toBe(2208)
  })

  it('throws on an unmapped country rather than guessing a market', () => {
    expect(() => locationCodeFor('ZZ')).toThrow(/No DataForSEO location code/)
  })
})

describe('MockSeoDataProvider', () => {
  it('accounts cost and bills each distinct canonical request exactly once', async () => {
    const capture = new MockPosthogCapture()
    const mock = new MockSeoDataProvider(
      { keywordMetrics: { løbesko: { monthlySearchVolume: 1300 } } },
      capture,
    )

    const a = await mock.keywordMetrics({
      keywords: ['løbesko'],
      locale: LOCALE,
      attribution: ATTRIBUTION,
    })
    // Same question, different casing and order: one billable read (§14.3.9).
    await mock.keywordMetrics({ keywords: ['Løbesko'], locale: LOCALE, attribution: ATTRIBUTION })
    // A different market is a different question.
    await mock.keywordMetrics({
      keywords: ['løbesko'],
      locale: { languageCode: 'sv', countryCode: 'SE' },
      attribution: ATTRIBUTION,
    })

    expect(a.data[0]!.monthlySearchVolume).toBe(1300)
    expect(mock.calls).toHaveLength(3)
    expect(mock.billableCalls).toBe(2)
    expect(mock.totalUsdCost).toBe(priceFor(DATAFORSEO_ENDPOINTS.keywordMetrics, 0) * 2)
    expect(capture.of('dataforseo_request')).toHaveLength(3)
  })

  it('keys on the same canonical function the live provider uses', () => {
    const key = seoCacheKey(DATAFORSEO_ENDPOINTS.serpOrganic, { keyword: 'a', depth: 10 })
    expect(seoCacheKey(DATAFORSEO_ENDPOINTS.serpOrganic, { depth: 10, keyword: 'a' })).toBe(key)
  })
})

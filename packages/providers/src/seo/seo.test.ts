import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InMemoryCostLedger,
  InMemoryRequestCache,
  UnrecordedSpend,
  accountAttribution,
  previewAttribution,
} from '@sortiva/core'
import { MockPosthogCapture } from '../posthog'
import { DataForSeoProvider, SeoRequestFailure } from './index'
import { seoCacheKey } from './key'
import { locationCodeFor } from './locations'
import { MockSeoDataProvider } from './mock'
import { DATAFORSEO_ENDPOINTS, assertEndpointsPriced, chargeFor, priceFor } from './pricing'

/**
 * T0.5 done-when: "cache tests (crash-after-response replays without
 * re-billing); a cached call captures `usd_cost: 0` / `cache_hit: true`; mock
 * providers account cost."
 *
 * Card R2 adds the audit's path table (`docs/audits/T0.5.md`): every exit from
 * this wrapper that reached DataForSEO must leave a cost record in *both* the
 * analytics capture (§14.7) and the spend ledger the §14.5 caps read
 * (invariant 17) — and the one exit that never reached the vendor must leave
 * neither.
 */

const LOCALE = { languageCode: 'da-DK', countryCode: 'DK' }
const ATTRIBUTION = accountAttribution('acc-1', 'example.dk')
const TASK_PRICE = priceFor(DATAFORSEO_ENDPOINTS.keywordMetrics, 0)

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
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch
}

describe('DataForSeoProvider', () => {
  let capture: MockPosthogCapture
  let ledger: InMemoryCostLedger

  beforeEach(() => {
    capture = new MockPosthogCapture()
    ledger = new InMemoryCostLedger()
  })

  function provider(options: Record<string, unknown> = {}) {
    return new DataForSeoProvider({ login: 'u', password: 'p', capture, ledger, ...options })
  }

  const metrics = (p: DataForSeoProvider) =>
    p.keywordMetrics({ keywords: ['løbesko'], locale: LOCALE, attribution: ATTRIBUTION })

  it('writes the raw vendor envelope to the cache before shaping it (invariant 20)', async () => {
    const cache = new InMemoryRequestCache()
    await metrics(provider({ cache, fetchImpl: fakeFetch(volumeResponse()) }))

    expect(cache.writes).toHaveLength(1)
    expect(cache.writes[0]).toMatch(/^dataforseo:keywords_data/)
    const stored = await cache.read(cache.writes[0]!)
    // The whole envelope, not the extracted rows: `extractResult` is processing,
    // and processing happens after the write.
    expect(stored!.responseJson).toEqual(volumeResponse())
  })

  it('replays from cache after a crash, without a second billable call', async () => {
    const cache = new InMemoryRequestCache()
    const fetchImpl = fakeFetch(volumeResponse())

    const before = await metrics(provider({ cache, fetchImpl }))
    expect(before.meta.billable).toBe(true)
    expect(before.meta.usdCost).toBe(TASK_PRICE)

    // The step crashed after the vendor answered; a new process retries it.
    const after = await metrics(provider({ cache, fetchImpl }))

    expect(after.data).toEqual(before.data)
    expect(after.meta.cacheHit).toBe(true)
    expect(after.meta.billable).toBe(false)
    expect(after.meta.usdCost).toBe(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const events = capture.of('dataforseo_request')
    expect(events).toHaveLength(2)
    expect(events[1]!.properties).toMatchObject({ cache_hit: true, usd_cost: 0, billable: false })
    expect(events[1]!.groups).toEqual({ domain: 'example.dk' })

    // §14.7 requirement (3): the replay is recorded at zero, not omitted.
    expect(ledger.rows).toHaveLength(2)
    expect(ledger.rows[1]).toMatchObject({ usdCost: 0, cacheHit: true, outcome: 'succeeded' })
    expect(ledger.totalUsdCost).toBe(TASK_PRICE)
  })

  it('canonicalises params, so keyword order is not a second billable read', async () => {
    const cache = new InMemoryRequestCache()
    const fetchImpl = fakeFetch(volumeResponse())
    const p = provider({ cache, fetchImpl })

    await p.keywordMetrics({
      keywords: ['løbesko', 'trailsko'],
      locale: LOCALE,
      attribution: ATTRIBUTION,
    })
    await p.keywordMetrics({
      keywords: ['Trailsko', ' løbesko '],
      locale: LOCALE,
      attribution: ATTRIBUTION,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('classifies a 429 as retryable and a 400 as terminal (main §14.3.5)', async () => {
    await expect(metrics(provider({ fetchImpl: fakeFetch({}, 429) }))).rejects.toMatchObject({
      retryable: true,
      errorClass: 'dataforseo_upstream',
    })
    await expect(metrics(provider({ fetchImpl: fakeFetch({}, 400) }))).rejects.toMatchObject({
      retryable: false,
      errorClass: 'dataforseo_bad_request',
    })
  })

  describe('every path that reached the vendor records a cost (remediation D2)', () => {
    it('records a rate limit as failed spend', async () => {
      await expect(metrics(provider({ fetchImpl: fakeFetch({}, 429) }))).rejects.toBeInstanceOf(
        SeoRequestFailure,
      )

      expect(ledger.rows).toHaveLength(1)
      expect(ledger.rows[0]).toMatchObject({
        vendor: 'dataforseo',
        callType: DATAFORSEO_ENDPOINTS.keywordMetrics,
        usdCost: TASK_PRICE,
        cacheHit: false,
        outcome: 'failed',
      })
      expect(capture.of('dataforseo_request')[0]!.properties).toMatchObject({ outcome: 'failed' })
    })

    it('records a vendor 500 as failed spend', async () => {
      await expect(metrics(provider({ fetchImpl: fakeFetch({}, 500) }))).rejects.toBeInstanceOf(
        SeoRequestFailure,
      )
      expect(ledger.withOutcome('failed')).toHaveLength(1)
      expect(ledger.totalUsdCost).toBe(TASK_PRICE)
    })

    it('records a dropped connection or timeout as failed spend', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error('socket hang up')
      }) as unknown as typeof fetch

      await expect(metrics(provider({ fetchImpl }))).rejects.toMatchObject({
        errorClass: 'dataforseo_connection',
      })
      expect(ledger.withOutcome('failed')).toHaveLength(1)
      expect(ledger.totalUsdCost).toBe(TASK_PRICE)
    })

    it('records a task-level error inside a 200 body, and caches it so a retry does not re-bill', async () => {
      const cache = new InMemoryRequestCache()
      const errorBody = { tasks: [{ status_code: 40501, status_message: 'invalid field' }] }
      const fetchImpl = fakeFetch(errorBody)

      await expect(metrics(provider({ cache, fetchImpl }))).rejects.toBeInstanceOf(
        SeoRequestFailure,
      )

      // Finding 4: the vendor executed and billed this request, so it leaves a
      // cost record *and* a cache row.
      expect(ledger.withOutcome('failed')).toHaveLength(1)
      expect(ledger.rows[0]!.usdCost).toBe(TASK_PRICE)
      expect(cache.writes).toHaveLength(1)

      // A retry replays the stored failure for free rather than paying again.
      await expect(metrics(provider({ cache, fetchImpl }))).rejects.toBeInstanceOf(
        SeoRequestFailure,
      )
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('records the cost when our own cache write fails after a good answer', async () => {
      const cache = new InMemoryRequestCache()
      cache.writeBeforeProcessing = async () => {
        throw new Error('database unavailable')
      }

      await expect(
        metrics(provider({ cache, fetchImpl: fakeFetch(volumeResponse()) })),
      ).rejects.toThrow(/database unavailable/)

      // Finding 5: DataForSEO was paid, so the row exists even though we never
      // stored the answer and the caller sees the storage error.
      expect(ledger.rows).toHaveLength(1)
      expect(ledger.rows[0]!.usdCost).toBe(TASK_PRICE)
    })

    it('records nothing when the request never reached the vendor', async () => {
      const unconfigured = new DataForSeoProvider({ login: '', password: '', capture, ledger })
      await expect(metrics(unconfigured)).rejects.toMatchObject({
        errorClass: 'dataforseo_unconfigured',
        retryable: false,
      })

      expect(ledger.rows).toHaveLength(0)
      expect(capture.events).toHaveLength(0)
    })

    it('does not let a ledger outage mask the vendor error or lose the answer', async () => {
      ledger.failWith = new Error('spend_events unreachable')

      // Success path: the caller still gets the data.
      const ok = await metrics(provider({ fetchImpl: fakeFetch(volumeResponse()) }))
      expect(ok.data[0]!.monthlySearchVolume).toBe(1300)

      // Failure path: the caller still gets the *vendor's* error, which the
      // §14.3.5 retry classification depends on — not a database error.
      await expect(metrics(provider({ fetchImpl: fakeFetch({}, 429) }))).rejects.toBeInstanceOf(
        SeoRequestFailure,
      )
    })
  })

  it('attributes preview spend to a target domain and no account', async () => {
    const p = provider({ fetchImpl: fakeFetch(volumeResponse()) })
    await p.keywordMetrics({
      keywords: ['løbesko'],
      locale: LOCALE,
      attribution: previewAttribution('nike.com'),
    })

    expect(ledger.rows[0]!.attribution).toEqual({
      kind: 'preview',
      targetDomain: 'nike.com',
      billableDomain: 'nike.com',
    })
    expect(capture.of('dataforseo_request')[0]!.groups).toEqual({})
  })

  it('lets a caller opt out of the ledger only by naming it (finding 6)', async () => {
    const silent = new DataForSeoProvider({
      login: 'u',
      password: 'p',
      capture,
      ledger: new UnrecordedSpend(),
      fetchImpl: fakeFetch(volumeResponse()),
    })
    await metrics(silent)
    expect(ledger.rows).toHaveLength(0)
    expect(capture.of('dataforseo_request')).toHaveLength(1)
  })
})

describe('endpoint pricing', () => {
  it('fails at load time, not after a call was billed (finding 10)', () => {
    // The real map is complete; this proves the guard fires on an incomplete one.
    expect(() => assertEndpointsPriced()).not.toThrow()
    expect(() => assertEndpointsPriced(['serp/some/new/endpoint'], {})).toThrow(
      /No price configured/,
    )
  })

  it('reports an unpriced endpoint as unknown rather than throwing mid-request', () => {
    expect(chargeFor('serp/some/new/endpoint', 0)).toEqual({ usdCost: 0, priceKnown: false })
    expect(chargeFor(DATAFORSEO_ENDPOINTS.keywordMetrics, 0)).toEqual({
      usdCost: TASK_PRICE,
      priceKnown: true,
    })
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
    const ledger = new InMemoryCostLedger()
    const mock = new MockSeoDataProvider(
      { keywordMetrics: { løbesko: { monthlySearchVolume: 1300 } } },
      capture,
      ledger,
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
    expect(mock.totalUsdCost).toBe(TASK_PRICE * 2)
    expect(capture.of('dataforseo_request')).toHaveLength(3)
    // The double meters what the live provider would: three rows, one free.
    expect(ledger.rows).toHaveLength(3)
    expect(ledger.totalUsdCost).toBe(TASK_PRICE * 2)
  })

  it('keys on the same canonical function the live provider uses', () => {
    const key = seoCacheKey(DATAFORSEO_ENDPOINTS.serpOrganic, { keyword: 'a', depth: 10 })
    expect(seoCacheKey(DATAFORSEO_ENDPOINTS.serpOrganic, { depth: 10, keyword: 'a' })).toBe(key)
  })
})

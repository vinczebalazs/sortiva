import type {
  EventAttribution,
  KeywordMetric,
  KeywordMetricsRequest,
  PosthogCapture,
  RankedKeyword,
  RankedKeywordsRequest,
  SeoCallMeta,
  SeoDataProvider,
  SeoResult,
  SerpRequest,
  SerpResult,
} from '@sortiva/core'
import { seoCacheKey } from './key'
import { languageCodeFor, locationCodeFor } from './locations'
import { DATAFORSEO_ENDPOINTS, priceFor } from './pricing'

/**
 * The `SeoDataProvider` test double (main §12.1: "swappable and mockable in
 * tests"; tech §5: staging runs against it, so real spend happens only in prod).
 *
 * It is not a stub that returns fixtures. It deduplicates by the same canonical
 * cache key as the live provider and accounts cost from the same price map,
 * which is what lets the chaos test assert §14.3.9's guarantee: "DataForSEO
 * billable-call count equals the number of *distinct* canonical requests."
 */

export interface SeoFixture {
  keywordMetrics?: Record<string, Partial<KeywordMetric>>
  serp?: Record<string, readonly SerpResult[]>
  rankedKeywords?: Record<string, readonly RankedKeyword[]>
}

export class MockSeoDataProvider implements SeoDataProvider {
  private readonly served = new Map<string, unknown>()

  /** One entry per call, cache hits included. */
  readonly calls: SeoCallMeta[] = []
  /** Distinct canonical requests actually billed. */
  billableCalls = 0
  totalUsdCost = 0

  constructor(
    private readonly fixture: SeoFixture = {},
    private readonly capture?: Pick<PosthogCapture, 'captureSeoRequest'>,
  ) {}

  reset(): void {
    this.served.clear()
    this.calls.length = 0
    this.billableCalls = 0
    this.totalUsdCost = 0
  }

  async keywordMetrics(
    request: KeywordMetricsRequest,
  ): Promise<SeoResult<readonly KeywordMetric[]>> {
    const keywords = [...request.keywords].map((k) => k.trim().toLowerCase()).sort()
    const key = seoCacheKey(DATAFORSEO_ENDPOINTS.keywordMetrics, {
      keywords,
      language_code: languageCodeFor(request.locale.languageCode),
      location_code: locationCodeFor(request.locale.countryCode),
    })
    const data: KeywordMetric[] = keywords.map((keyword) => ({
      keyword,
      monthlySearchVolume: null,
      competition: null,
      cpcUsd: null,
      monthlyHistory: [],
      ...(this.fixture.keywordMetrics?.[keyword] ?? {}),
    }))
    return this.serve(DATAFORSEO_ENDPOINTS.keywordMetrics, key, data, 0, request.attribution)
  }

  async serpTop(request: SerpRequest): Promise<SeoResult<readonly SerpResult[]>> {
    const keyword = request.keyword.trim().toLowerCase()
    const key = seoCacheKey(DATAFORSEO_ENDPOINTS.serpOrganic, {
      keyword,
      language_code: languageCodeFor(request.locale.languageCode),
      location_code: locationCodeFor(request.locale.countryCode),
      depth: request.depth,
    })
    const data = (this.fixture.serp?.[keyword] ?? []).slice(0, request.depth)
    return this.serve(DATAFORSEO_ENDPOINTS.serpOrganic, key, data, 0, request.attribution)
  }

  async rankedKeywords(
    request: RankedKeywordsRequest,
  ): Promise<SeoResult<readonly RankedKeyword[]>> {
    const target = request.target.trim().toLowerCase()
    const key = seoCacheKey(DATAFORSEO_ENDPOINTS.rankedKeywords, {
      target,
      language_code: languageCodeFor(request.locale.languageCode),
      location_code: locationCodeFor(request.locale.countryCode),
      limit: request.limit,
    })
    const data = (this.fixture.rankedKeywords?.[target] ?? []).slice(0, request.limit)
    return this.serve(
      DATAFORSEO_ENDPOINTS.rankedKeywords,
      key,
      data,
      data.length,
      request.attribution,
    )
  }

  private serve<T>(
    endpoint: string,
    cacheKey: string,
    data: T,
    rows: number,
    attribution: EventAttribution,
  ): SeoResult<T> {
    const cacheHit = this.served.has(cacheKey)
    if (!cacheHit) this.served.set(cacheKey, data)

    const meta: SeoCallMeta = {
      endpoint,
      cacheHit,
      billable: !cacheHit,
      usdCost: cacheHit ? 0 : priceFor(endpoint, rows),
    }
    if (!cacheHit) {
      this.billableCalls += 1
      this.totalUsdCost = Math.round((this.totalUsdCost + meta.usdCost) * 1_000_000) / 1_000_000
    }
    this.calls.push(meta)
    this.capture?.captureSeoRequest({ attribution, ...meta })
    return { data: cacheHit ? (this.served.get(cacheKey) as T) : data, meta }
  }
}

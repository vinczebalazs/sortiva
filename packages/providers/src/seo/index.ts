import {
  NullRequestCache,
  type EventAttribution,
  type KeywordMetric,
  type KeywordMetricsRequest,
  type Logger,
  type PosthogCapture,
  type RankedKeyword,
  type RankedKeywordsRequest,
  type RequestCache,
  type SeoCallMeta,
  type SeoDataProvider,
  type SeoResult,
  type SerpRequest,
  type SerpResult,
} from '@sortiva/core'
import { recordSpend, type CostLedger, type SpendOutcome } from '../spend'
import { seoCacheKey } from './key'
import { languageCodeFor, locationCodeFor } from './locations'
import { DATAFORSEO_ENDPOINTS, ENDPOINT_PRICES, chargeFor } from './pricing'

/**
 * main §12.1 / §14.3.6 / §14.7 — the one path to DataForSEO. Invariant 25 makes
 * this the only place allowed to talk to the vendor, which is what guarantees:
 *
 * - **Every request is cached before it is processed** (invariant 20). The
 *   vendor's raw envelope is stored the moment it is parsed as JSON, before
 *   anything inspects it — DataForSEO reports per-request failures *inside* an
 *   otherwise-successful HTTP response, and inspecting first left a call the
 *   vendor had already executed and billed with no cache row, so a retry paid
 *   twice (audit `docs/audits/T0.5.md` finding 4).
 * - **Every call that reaches the vendor is recorded twice**: as §14.7's
 *   `dataforseo_request` analytics event, and as a row in the spend ledger the
 *   §14.5 caps read (invariant 17). That includes the failures — a connection
 *   drop, a rate limit, a 5xx and a task-level error all leave a row marked
 *   `outcome: 'failed'`, because DataForSEO bills for work performed, not for
 *   bytes we received. A call that never reached the vendor (no credentials)
 *   records nothing, correctly.
 * - **Params are canonicalised** before hashing — sorted keys, normalised locale
 *   codes (§14.3.6) — so the same question asked twice is one billable read.
 */

/**
 * §14.3.6 fixes the request-cache TTL at 24h. §12.1's 30-day keyword and 7-day
 * SERP TTLs are the *semantic* layer above this one, owned by the cards that
 * persist keywords and SERP snapshots; this cache exists to make a step retry
 * free, not to be the product's memory.
 */
const REQUEST_CACHE_TTL_MS = 24 * 60 * 60 * 1000

const DEFAULT_BASE_URL = 'https://api.dataforseo.com/v3'

/** main §14.3.5 — the class, not the exception's shape, decides what happens next. */
export class SeoRequestFailure extends Error {
  constructor(
    readonly retryable: boolean,
    readonly errorClass: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions)
    this.name = 'SeoRequestFailure'
  }
}

export interface DataForSeoProviderOptions {
  /**
   * §14.7's analytics capture. **Required** — an optional recorder meant a
   * wrapper built without one spent real money and produced no record, with no
   * error and no log line. Pass `new UnrecordedCapture()` to opt out by name
   * (audit `docs/audits/T0.5.md` finding 6).
   */
  capture: Pick<PosthogCapture, 'captureSeoRequest'>
  /**
   * The §14.5 spend meter (invariant 17). Required for the same reason. Pass
   * `new UnrecordedSpend()` to opt out by name.
   */
  ledger: CostLedger
  login?: string
  password?: string
  baseUrl?: string
  cache?: RequestCache
  fetchImpl?: typeof fetch
  now?: () => number
  logger?: Logger
}

interface TaskEnvelope {
  status_code?: number
  status_message?: string
  tasks?: {
    status_code?: number
    status_message?: string
    result?: unknown[] | null
  }[]
}

export class DataForSeoProvider implements SeoDataProvider {
  private readonly login: string
  private readonly password: string
  private readonly baseUrl: string
  private readonly cache: RequestCache
  private readonly capture: Pick<PosthogCapture, 'captureSeoRequest'>
  private readonly ledger: CostLedger
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly logger: Logger | undefined

  constructor(options: DataForSeoProviderOptions) {
    this.login = options.login ?? process.env.DATAFORSEO_LOGIN ?? ''
    this.password = options.password ?? process.env.DATAFORSEO_PASSWORD ?? ''
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.cache = options.cache ?? new NullRequestCache()
    this.capture = options.capture
    this.ledger = options.ledger
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => Date.now())
    this.logger = options.logger
  }

  async keywordMetrics(
    request: KeywordMetricsRequest,
  ): Promise<SeoResult<readonly KeywordMetric[]>> {
    const endpoint = DATAFORSEO_ENDPOINTS.keywordMetrics
    const task = {
      keywords: [...request.keywords].map((k) => k.trim().toLowerCase()).sort(),
      language_code: languageCodeFor(request.locale.languageCode),
      location_code: locationCodeFor(request.locale.countryCode),
    }
    const { rows, meta } = await this.call(endpoint, task, request.attribution)
    return { data: rows.map(toKeywordMetric), meta }
  }

  async serpTop(request: SerpRequest): Promise<SeoResult<readonly SerpResult[]>> {
    const endpoint = DATAFORSEO_ENDPOINTS.serpOrganic
    const task = {
      keyword: request.keyword.trim().toLowerCase(),
      language_code: languageCodeFor(request.locale.languageCode),
      location_code: locationCodeFor(request.locale.countryCode),
      depth: request.depth,
    }
    const { rows, meta } = await this.call(endpoint, task, request.attribution)
    // The organic endpoint nests one level deeper: result[0].items.
    return { data: firstItems(rows).filter(isOrganic).map(toSerpResult), meta }
  }

  async rankedKeywords(
    request: RankedKeywordsRequest,
  ): Promise<SeoResult<readonly RankedKeyword[]>> {
    const endpoint = DATAFORSEO_ENDPOINTS.rankedKeywords
    const task = {
      target: request.target.trim().toLowerCase(),
      language_code: languageCodeFor(request.locale.languageCode),
      location_code: locationCodeFor(request.locale.countryCode),
      limit: request.limit,
    }
    const { rows, meta } = await this.call(endpoint, task, request.attribution)
    return { data: firstItems(rows).map(toRankedKeyword), meta }
  }

  /**
   * One billable read: a cache lookup, or an HTTP call whose raw envelope is
   * stored before anything reads it. Returns the vendor's `result` array
   * untouched — shaping happens after the cache write, on purpose.
   *
   * Every exit from this method below the `post` call writes a cost record,
   * because every one of them is a call DataForSEO has already performed.
   */
  private async call(
    endpoint: string,
    task: Record<string, unknown>,
    attribution: EventAttribution,
  ): Promise<{ rows: unknown[]; meta: SeoCallMeta }> {
    const cacheKey = seoCacheKey(endpoint, task)

    const cached = await this.cache.read(cacheKey)
    if (cached) {
      const meta: SeoCallMeta = { endpoint, cacheHit: true, billable: false, usdCost: 0 }
      // Processing the stored envelope happens *after* the read, so a replay
      // walks the same path a fresh response does — including a stored
      // task-level error, which fails identically instead of re-billing.
      const rows = extractResult(endpoint, cached.responseJson as TaskEnvelope)
      await this.record(attribution, meta, 'succeeded', true)
      return { rows, meta }
    }

    const sent = await this.post(endpoint, task)
    if (!sent.reached) {
      // Nothing was spent: no credentials means no request left the process.
      throw sent.error
    }

    // Below this line DataForSEO has done the work and billed for it, whatever
    // happens next — so the record is written in a `finally` that no exception
    // and no early return can skip.
    const floor = chargeFor(endpoint, 0)
    let meta: SeoCallMeta = {
      endpoint,
      cacheHit: false,
      billable: true,
      usdCost: floor.usdCost,
    }
    let priceKnown = floor.priceKnown
    let outcome: SpendOutcome = 'failed'
    try {
      if (!sent.ok) throw sent.error

      // Invariant 20 / §14.3.6 — the raw envelope is stored before it is
      // inspected. `extractResult` below is processing: it is where a
      // task-level failure inside a 200 body is found.
      await this.cache.writeBeforeProcessing({
        cacheKey,
        kind: 'dataforseo',
        responseJson: sent.body,
        expiresAt: new Date(this.now() + REQUEST_CACHE_TTL_MS),
      })

      const rows = extractResult(endpoint, sent.body)
      const charge = chargeFor(endpoint, countRows(endpoint, rows))
      meta = { endpoint, cacheHit: false, billable: true, usdCost: charge.usdCost }
      priceKnown = charge.priceKnown
      outcome = 'succeeded'
      return { rows, meta }
    } finally {
      await this.record(attribution, meta, outcome, priceKnown)
    }
  }

  /**
   * §14.7 requires the analytics event; invariant 17 requires the database
   * counter the §14.5 caps read. Both, from one place, so neither can be
   * forgotten on a path the other covers.
   */
  private async record(
    attribution: EventAttribution,
    meta: SeoCallMeta,
    outcome: SpendOutcome,
    priceKnown: boolean,
  ): Promise<void> {
    if (!priceKnown) {
      this.logger?.error('dataforseo_endpoint_unpriced', { endpoint: meta.endpoint })
    }
    this.capture.captureSeoRequest({
      attribution,
      ...meta,
      properties: { outcome, ...(priceKnown ? {} : { price_unknown: true }) },
    })
    await recordSpend(
      this.ledger,
      {
        attribution,
        vendor: 'dataforseo',
        callType: meta.endpoint,
        usdCost: meta.usdCost,
        cacheHit: meta.cacheHit,
        outcome,
      },
      this.logger,
    )
  }

  /**
   * Returns rather than throws, because the caller has to distinguish two cases
   * a thrown error cannot: a request that never left the process (nothing
   * spent) from one the vendor answered badly (spent).
   */
  private async post(
    endpoint: string,
    task: Record<string, unknown>,
  ): Promise<
    | { reached: false; error: SeoRequestFailure }
    | { reached: true; ok: true; body: TaskEnvelope }
    | { reached: true; ok: false; error: SeoRequestFailure }
  > {
    if (!this.login || !this.password) {
      return {
        reached: false,
        error: new SeoRequestFailure(
          false,
          'dataforseo_unconfigured',
          'DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set. Use MockSeoDataProvider outside production (tech §5).',
        ),
      }
    }

    const auth = Buffer.from(`${this.login}:${this.password}`).toString('base64')
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/${endpoint}`, {
        method: 'POST',
        headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
        body: JSON.stringify([task]),
      })
    } catch (error) {
      // A dropped connection or a timeout: the request was sent, so the vendor
      // may well have run it. Treated as reached, and recorded.
      return {
        reached: true,
        ok: false,
        error: new SeoRequestFailure(
          true,
          'dataforseo_connection',
          `${endpoint}: ${String(error)}`,
          { cause: error },
        ),
      }
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500
      return {
        reached: true,
        ok: false,
        error: new SeoRequestFailure(
          retryable,
          retryable ? 'dataforseo_upstream' : 'dataforseo_bad_request',
          `${endpoint}: DataForSEO returned ${response.status}`,
        ),
      }
    }

    try {
      return { reached: true, ok: true, body: (await response.json()) as TaskEnvelope }
    } catch (error) {
      // A 200 whose body is truncated or not JSON. The vendor answered; we
      // cannot use it, and cannot cache what we could not parse.
      return {
        reached: true,
        ok: false,
        error: new SeoRequestFailure(
          true,
          'dataforseo_unreadable',
          `${endpoint}: DataForSEO returned an unreadable body`,
          { cause: error },
        ),
      }
    }
  }
}

/** DataForSEO reports per-task failures inside a 200 body, so the status codes are checked here. */
function extractResult(endpoint: string, body: TaskEnvelope): unknown[] {
  const task = body.tasks?.[0]
  if (!task) {
    throw new SeoRequestFailure(true, 'dataforseo_empty', `${endpoint}: response contained no task`)
  }
  // 20000-range codes are success; 40000+ are client errors, 50000+ vendor-side.
  const status = task.status_code ?? body.status_code ?? 0
  if (status >= 40000) {
    const retryable = status >= 50000
    throw new SeoRequestFailure(
      retryable,
      retryable ? 'dataforseo_upstream' : 'dataforseo_task_error',
      `${endpoint}: task status ${status} ${task.status_message ?? ''}`.trim(),
    )
  }
  return task.result ?? []
}

/** Ranked-keywords bills per row; the others bill per task, so row count is irrelevant there. */
function countRows(endpoint: string, rows: unknown[]): number {
  if (ENDPOINT_PRICES[endpoint]?.perRowUsd === 0) return 0
  return firstItems(rows).length
}

function firstItems(rows: unknown[]): Record<string, unknown>[] {
  const first = rows[0] as { items?: unknown } | undefined
  return Array.isArray(first?.items) ? (first.items as Record<string, unknown>[]) : []
}

function isOrganic(item: Record<string, unknown>): boolean {
  return item.type === 'organic'
}

function toKeywordMetric(row: unknown): KeywordMetric {
  const r = row as Record<string, unknown>
  return {
    keyword: String(r.keyword ?? ''),
    monthlySearchVolume: numberOrNull(r.search_volume),
    competition: numberOrNull(r.competition),
    cpcUsd: numberOrNull(r.cpc),
    monthlyHistory: Array.isArray(r.monthly_searches)
      ? (r.monthly_searches as Record<string, unknown>[]).map((m) => Number(m.search_volume ?? 0))
      : [],
  }
}

function toSerpResult(item: Record<string, unknown>): SerpResult {
  return {
    position: Number(item.rank_absolute ?? 0),
    url: String(item.url ?? ''),
    domain: String(item.domain ?? ''),
    title: typeof item.title === 'string' ? item.title : null,
  }
}

function toRankedKeyword(item: Record<string, unknown>): RankedKeyword {
  const keywordData = (item.keyword_data ?? {}) as Record<string, unknown>
  const info = (keywordData.keyword_info ?? {}) as Record<string, unknown>
  const serpItem = (((item.ranked_serp_element ?? {}) as Record<string, unknown>).serp_item ??
    {}) as Record<string, unknown>
  return {
    keyword: String(keywordData.keyword ?? ''),
    position: Number(serpItem.rank_absolute ?? 0),
    url: String(serpItem.url ?? ''),
    monthlySearchVolume: numberOrNull(info.search_volume),
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export * from './key'
export * from './locations'
export * from './pricing'
export { MockSeoDataProvider, type SeoFixture } from './mock'

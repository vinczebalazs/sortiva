import { createHash } from 'node:crypto'
import type { ShopifyAuth } from '@sortiva/core'
import { assertShop, SHOPIFY_API_VERSION } from './oauth'
import { ShopifyRateLimiters, type ShopifyRateLimiterOptions, type ThrottleStatus } from './limiter'

/**
 * The one way a request reaches a merchant's store.
 *
 * Every read and every write goes through `ShopifyGraphqlClient.request`, so
 * the behaviours that decide what a merchant experiences are made once:
 *
 *  - a token near the end of its hour is renewed before it is used, and a token
 *    Shopify refuses is renewed once and the request tried again, so an expiring
 *    token never looks like a lost connection;
 *  - each kind of refusal is its own failure, because they need opposite
 *    responses — a dead grant sends the merchant to reconnect, a missing
 *    permission or an unapproved kind of data must *not*, and a frozen store is
 *    neither;
 *  - pacing follows the cost Shopify reports on every answer, and a throttled
 *    request waits and is sent again rather than failing the walk it is part of.
 */

/** A token Shopify refused, and no replacement worked. Only the merchant can fix it. */
export class ShopifyTokenInvalid extends Error {
  override readonly name = 'ShopifyTokenInvalid'
  readonly retryable = false
  readonly errorClass = 'shopify_token_invalid'

  constructor(
    readonly shop: string,
    status: number,
    /** A fingerprint of the refused token, so a caller can tell it from one saved since. */
    readonly rejectedToken?: string,
  ) {
    super(`Shopify rejected our token for ${shop} (${status}).`)
  }
}

/**
 * The token is fine; this request needs a permission or an approval we do not
 * have. Reconnecting cannot fix it, so it must never be routed there — the
 * commonest case is order data before Shopify has approved our access to it.
 */
export class ShopifyAccessDenied extends Error {
  override readonly name = 'ShopifyAccessDenied'
  readonly retryable = false
  readonly errorClass = 'shopify_access_denied'
  constructor(readonly shop: string, detail: string) {
    super(`Shopify denied access for ${shop}: ${detail}`)
  }
}

/**
 * The store itself cannot be read right now — frozen for an unpaid bill,
 * locked, or closed. Not our connection's fault, and not something a retry in
 * the next minute changes; the next scheduled pass tries again.
 */
export class ShopifyStoreUnavailable extends Error {
  override readonly name = 'ShopifyStoreUnavailable'
  readonly retryable = false
  readonly errorClass = 'shopify_store_unavailable'
  constructor(readonly shop: string, readonly status: number) {
    super(`Shopify says ${shop} is unavailable (${status}).`)
  }
}

/** A failure worth trying again, or — when `retryable` is false — a request Shopify would not accept. */
export class ShopifyApiFailure extends Error {
  override readonly name = 'ShopifyApiFailure'
  readonly retryable: boolean
  readonly errorClass: string
  readonly retryAfterMs: number | undefined

  constructor(
    message: string,
    options: { retryable?: boolean; retryAfterMs?: number; errorClass?: string; cause?: unknown } = {},
  ) {
    super(message, options as ErrorOptions)
    this.retryable = options.retryable ?? true
    this.retryAfterMs = options.retryAfterMs
    this.errorClass =
      options.errorClass ??
      (options.retryAfterMs === undefined ? 'shopify_api_error' : 'shopify_rate_limited')
  }
}

/**
 * Shopify would not run the query as written. A bug of ours, not a condition to
 * wait out, so it is not retried — and it is loud, because the alternative is a
 * walk that quietly reads nothing.
 */
export class ShopifyQueryRejected extends Error {
  override readonly name = 'ShopifyQueryRejected'
  readonly retryable = false
  readonly errorClass: string
  constructor(message: string, errorClass = 'shopify_query_rejected') {
    super(message)
    this.errorClass = errorClass
  }
}

export interface ShopifyRequest {
  readonly query: string
  readonly variables?: Readonly<Record<string, unknown>>
  /**
   * What we expect the request to cost, so the limiter can wait for it before
   * sending. A rough figure is enough; Shopify's own answer corrects the
   * bucket afterwards.
   */
  readonly expectedCost?: number
  /**
   * The request filters with Shopify's search syntax and its answer is only
   * true if every filter was applied. Shopify ignores a filter it does not
   * understand and says so in a warning; with this set, that warning is a
   * failure instead of a silently wider answer.
   */
  readonly strictSearch?: boolean
}

export interface ShopifyGraphqlClientOptions {
  fetchImpl?: typeof fetch
  /** Overrides the `https://<shop>.myshopify.com` base. Tests only. */
  storeBaseUrl?: (shop: string) => string
  limiter?: ShopifyRateLimiterOptions
  /** How many times a throttled request waits and goes again before the caller hears about it. */
  maxThrottleRetries?: number
}

const DEFAULT_EXPECTED_COST = 100
const DEFAULT_MAX_THROTTLE_RETRIES = 4
/** What a throttle that names no wait is waited out with. */
const UNSTATED_THROTTLE_MS = 1_000

interface GraphqlError {
  readonly message?: string
  readonly extensions?: { readonly code?: string; readonly requiredAccess?: string }
}

interface GraphqlBody {
  readonly data?: unknown
  readonly errors?: readonly GraphqlError[]
  readonly extensions?: {
    readonly cost?: { readonly requestedQueryCost?: number; readonly throttleStatus?: ThrottleStatus }
    readonly search?: readonly { readonly warnings?: readonly { readonly field?: string; readonly message?: string }[] }[]
  }
}

export class ShopifyGraphqlClient {
  private readonly fetchImpl: typeof fetch
  private readonly storeBaseUrl: (shop: string) => string
  private readonly limiters: ShopifyRateLimiters
  private readonly maxThrottleRetries: number

  constructor(options: ShopifyGraphqlClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.storeBaseUrl = options.storeBaseUrl ?? ((shop) => `https://${shop}.myshopify.com`)
    this.limiters = new ShopifyRateLimiters(options.limiter ?? {})
    this.maxThrottleRetries = options.maxThrottleRetries ?? DEFAULT_MAX_THROTTLE_RETRIES
  }

  /** Sends one query or mutation and answers with its `data`. */
  async request<T>(auth: ShopifyAuth, request: ShopifyRequest): Promise<T> {
    assertShop(auth.shop)
    const limiter = this.limiters.for(auth.shop)
    const expectedCost = request.expectedCost ?? DEFAULT_EXPECTED_COST

    for (let attempt = 0; ; attempt += 1) {
      const outcome = await limiter.run(expectedCost, () => this.sendWithRenewal(auth, request))
      limiter.observe(outcome.body?.extensions?.cost?.throttleStatus)

      const retryAfterMs = throttledFor(outcome, expectedCost)
      if (retryAfterMs !== undefined) {
        // The bucket that emptied is the store's, so every caller waits, not
        // just this one.
        limiter.pauseFor(retryAfterMs)
        if (attempt < this.maxThrottleRetries) continue
        throw new ShopifyApiFailure(`Shopify kept throttling requests to ${auth.shop}.`, {
          retryAfterMs,
        })
      }
      return dataOf<T>(auth.shop, outcome.body!, request)
    }
  }

  /**
   * One send, and — when Shopify refuses the token — one more with whatever
   * token the auth offers instead. A token that expired a minute ago, or that
   * another worker already renewed, costs one extra request rather than a
   * reconnect prompt.
   */
  private async sendWithRenewal(auth: ShopifyAuth, request: ShopifyRequest): Promise<SendOutcome> {
    const token = await auth.accessToken()
    const first = await this.send(auth.shop, token, request)
    if (first.status !== 401) return first

    const replacement = await auth.refreshed(token)
    if (!replacement || replacement === token) {
      throw new ShopifyTokenInvalid(auth.shop, 401, tokenFingerprint(token))
    }
    const second = await this.send(auth.shop, replacement, request)
    if (second.status === 401) {
      throw new ShopifyTokenInvalid(auth.shop, 401, tokenFingerprint(replacement))
    }
    return second
  }

  private async send(shop: string, token: string, request: ShopifyRequest): Promise<SendOutcome> {
    let response: Response
    try {
      response = await this.fetchImpl(
        `${this.storeBaseUrl(shop)}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          method: 'POST',
          headers: {
            'x-shopify-access-token': token,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({ query: request.query, variables: request.variables ?? {} }),
        },
      )
    } catch (cause) {
      throw new ShopifyApiFailure(`Could not reach Shopify for ${shop}.`, { cause })
    }

    const status = response.status
    if (status === 401) {
      await discard(response)
      return { status }
    }
    if (status === 403) {
      await discard(response)
      throw new ShopifyAccessDenied(shop, 'the request was forbidden (403)')
    }
    // 402: the store is frozen for an unpaid bill. 423: locked. 404 on the one
    // endpoint every store has: the store is gone.
    if (status === 402 || status === 423 || status === 404) {
      await discard(response)
      throw new ShopifyStoreUnavailable(shop, status)
    }
    if (status === 429) {
      await discard(response)
      return { status, retryAfterMs: retryAfterFrom(response.headers.get('retry-after')) }
    }
    if (!response.ok) {
      await discard(response)
      throw new ShopifyApiFailure(`Shopify answered ${status} for ${shop}.`, {
        retryable: status >= 500,
      })
    }
    const body = (await response.json().catch(() => undefined)) as GraphqlBody | undefined
    if (!body || typeof body !== 'object') {
      throw new ShopifyApiFailure(`Shopify answered ${shop} with something that was not JSON.`)
    }
    return { status, body }
  }
}

interface SendOutcome {
  readonly status: number
  readonly body?: GraphqlBody
  readonly retryAfterMs?: number
}

/** How long to wait when this answer was a throttle, or undefined when it was not. */
function throttledFor(outcome: SendOutcome, expectedCost: number): number | undefined {
  if (outcome.status === 429) return outcome.retryAfterMs ?? UNSTATED_THROTTLE_MS
  const errors = outcome.body?.errors ?? []
  if (!errors.some((error) => error.extensions?.code === 'THROTTLED')) return undefined
  const cost = outcome.body?.extensions?.cost
  const status = cost?.throttleStatus
  if (!status || !(status.restoreRate > 0)) return UNSTATED_THROTTLE_MS
  const needed = (cost?.requestedQueryCost ?? expectedCost) - status.currentlyAvailable
  return Math.max(0, Math.ceil((needed / status.restoreRate) * 1000))
}

function dataOf<T>(shop: string, body: GraphqlBody, request: ShopifyRequest): T {
  const errors = body.errors ?? []
  if (errors.length > 0) {
    const denied = errors.find((error) => error.extensions?.code === 'ACCESS_DENIED')
    if (denied) throw new ShopifyAccessDenied(shop, denied.message ?? 'access denied')
    if (errors.some((error) => error.extensions?.code === 'INTERNAL_SERVER_ERROR')) {
      throw new ShopifyApiFailure(`Shopify failed while answering ${shop}.`)
    }
    // Partial data alongside an error is still an error: a page that silently
    // lacks the field that failed would be written down as the truth.
    throw new ShopifyQueryRejected(
      `Shopify would not run a query for ${shop}: ${errors.map((error) => error.message ?? '?').join('; ')}`,
    )
  }
  if (request.strictSearch) {
    const ignored = (body.extensions?.search ?? []).flatMap((entry) => entry.warnings ?? [])
    if (ignored.length > 0) {
      throw new ShopifyQueryRejected(
        `Shopify ignored part of a search for ${shop}: ` +
          ignored.map((warning) => `${warning.field ?? '?'} (${warning.message ?? '?'})`).join('; '),
        'shopify_search_ignored',
      )
    }
  }
  if (body.data === undefined || body.data === null) {
    throw new ShopifyQueryRejected(`Shopify answered a query for ${shop} with no data.`)
  }
  return body.data as T
}

/**
 * Reads and throws away a body we are not going to look at.
 *
 * An unread response body holds its connection open until the runtime decides
 * to collect it, and this client makes a request per page of every store's
 * catalogue — so the refusals, which are exactly the responses nobody reads,
 * are also exactly the ones that would accumulate.
 */
async function discard(response: Response): Promise<void> {
  try {
    await response.arrayBuffer()
  } catch {
    // A body that cannot be read is already gone, which is what we wanted.
  }
}

/** Shopify sends seconds. Honoured exactly rather than rounded up to a default. */
export function retryAfterFrom(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return Math.ceil(seconds * 1000)
}

/**
 * A short, one-way fingerprint of a token, so "was it this token that failed?"
 * can be asked without the token itself travelling in errors and logs.
 */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

/** `gid://shopify/Product/123` → `123`: the numeric id webhooks and our rows use. */
export function legacyIdOf(gid: string | number | null | undefined): string {
  if (gid === null || gid === undefined) return ''
  const text = String(gid)
  const slash = text.lastIndexOf('/')
  const tail = slash === -1 ? text : text.slice(slash + 1)
  const query = tail.indexOf('?')
  return query === -1 ? tail : tail.slice(0, query)
}

/** `('Article', '123')` → `gid://shopify/Article/123`. Accepts an id that is already global. */
export function gidOf(type: string, id: string): string {
  return id.startsWith('gid://') ? id : `gid://shopify/${type}/${id}`
}

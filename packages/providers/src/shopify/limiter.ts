/**
 * How fast we are allowed to talk to one store.
 *
 * Shopify hands each store a bucket that refills at roughly two requests a
 * second. Background work spends half of it, so a merchant clicking something in
 * their own admin — or a webhook-driven re-read of one page — is never queued
 * behind a walk of a five-hundred-product catalogue. The other half is headroom
 * we deliberately never touch.
 *
 * The limiter is per store, not per process: two stores are two independent
 * buckets at Shopify's end, and sharing one limiter between them would make a
 * large store's sync throttle everybody else's.
 */

/** Requests per second for background work. Half of Shopify's ~2/s refill; the rest is headroom. */
export const BACKGROUND_REQUESTS_PER_SECOND = 1

/**
 * What we wait when Shopify rate-limits us without saying for how long. Long
 * enough for a leaky bucket to refill a slot, short enough not to stall a sync.
 */
const UNSPECIFIED_RETRY_AFTER_MS = 1_000

export interface ShopifyRateLimiterOptions {
  requestsPerSecond?: number
  /** Injected by tests so a burst can be measured on a virtual clock rather than in real seconds. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Lets one request through at a time, no faster than the configured rate, and
 * stops entirely for as long as Shopify asks.
 *
 * Callers queue rather than fail: a sync that hit the limit should slow down,
 * not error. The queue is a promise chain, so requests leave in the order they
 * arrived and a burst of twelve is spread across twelve seconds rather than
 * spent in one.
 */
export class ShopifyRateLimiter {
  private readonly intervalMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  /** The earliest moment the next request may leave. */
  private nextAt = 0
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: ShopifyRateLimiterOptions = {}) {
    const perSecond = options.requestsPerSecond ?? BACKGROUND_REQUESTS_PER_SECOND
    if (perSecond <= 0) throw new Error('ShopifyRateLimiter needs a positive rate')
    this.intervalMs = 1000 / perSecond
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /**
   * Resolves when the caller may make its request.
   *
   * Deliberately not an `async` function: returning the chained promise
   * directly keeps the caller's continuation ahead of the next queued request,
   * so requests are observed leaving in the same order they were let go.
   */
  acquire(): Promise<void> {
    // A failed predecessor must not break the chain for everyone behind it, so
    // the stored link swallows rejections while the returned one does not.
    const turn = this.queue.then(() => this.take())
    this.queue = turn.catch(() => undefined)
    return turn
  }

  private async take(): Promise<void> {
    const now = this.now()
    const at = Math.max(now, this.nextAt)
    if (at > now) await this.sleep(at - now)
    this.nextAt = Math.max(this.now(), at) + this.intervalMs
  }

  /**
   * Shopify said wait. Honoured exactly rather than rounded up to a default:
   * the header is the store's own bucket telling us when it refills, and
   * guessing longer wastes a merchant's sync window while guessing shorter
   * earns another 429.
   */
  pauseFor(ms: number | undefined): void {
    const wait = ms === undefined || ms <= 0 ? UNSPECIFIED_RETRY_AFTER_MS : ms
    this.nextAt = Math.max(this.nextAt, this.now() + wait)
  }
}

/**
 * One limiter per store, kept for the life of the client.
 *
 * Without this the limiter would be per call site, and the two things that read
 * a store on the same night — the catalogue sync and the content inventory —
 * would each believe they were the only one talking to it and together exceed
 * the budget.
 */
export class ShopifyRateLimiters {
  private readonly byShop = new Map<string, ShopifyRateLimiter>()

  constructor(private readonly options: ShopifyRateLimiterOptions = {}) {}

  for(shop: string): ShopifyRateLimiter {
    let limiter = this.byShop.get(shop)
    if (!limiter) {
      limiter = new ShopifyRateLimiter(this.options)
      this.byShop.set(shop, limiter)
    }
    return limiter
  }
}

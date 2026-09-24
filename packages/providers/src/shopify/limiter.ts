/**
 * How fast we are allowed to talk to one store.
 *
 * Shopify's GraphQL API gives each store a bucket of cost points that refills
 * at a fixed rate — 100 a second on a standard plan, more on larger ones — and
 * reports, on every answer, how full the bucket is and what the request cost.
 * We pace on those numbers rather than on a guess: before a request leaves, we
 * wait until the bucket would still be at least half full after paying for it.
 * The other half is headroom we deliberately never touch, so a merchant working
 * in their own admin, or another app they use, is never starved by our
 * background walk of their catalogue.
 *
 * The limiter is per store, not per process: two stores are two independent
 * buckets at Shopify's end, and sharing one limiter between them would make a
 * large store's sync throttle everybody else's.
 */

/** The share of a store's bucket background work leaves untouched. */
export const RESERVED_BUCKET_SHARE = 0.5

/**
 * What we wait when Shopify throttles us without saying for how long. Long
 * enough for a slow bucket to refill a typical request, short enough not to
 * stall a sync.
 */
const UNSPECIFIED_RETRY_AFTER_MS = 1_000

/** Shopify's bucket as its last answer described it. */
export interface ThrottleStatus {
  readonly maximumAvailable: number
  readonly currentlyAvailable: number
  readonly restoreRate: number
}

export interface ShopifyRateLimiterOptions {
  /** Overrides the reserved share. Tests only. */
  reservedShare?: number
  /** Injected by tests so waits can be measured on a virtual clock rather than in real seconds. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Lets one request to a store through at a time, and only when the bucket can
 * pay for it and keep its reserve.
 *
 * One at a time is what makes the bucket readable: a request's answer reports
 * the bucket after that request, and the next request waits for that report
 * before deciding. Callers queue rather than fail — a sync that meets the limit
 * slows down instead of erroring — and they leave in the order they arrived.
 */
export class ShopifyRateLimiter {
  private readonly reservedShare: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private queue: Promise<unknown> = Promise.resolve()
  private known: { status: ThrottleStatus; at: number } | undefined
  private pausedUntil = 0

  constructor(options: ShopifyRateLimiterOptions = {}) {
    this.reservedShare = options.reservedShare ?? RESERVED_BUCKET_SHARE
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /**
   * Runs `send` when it is this caller's turn and the bucket can afford
   * `expectedCost`. The slot is held until `send` settles, so the next request
   * decides on the bucket this one left behind.
   */
  run<T>(expectedCost: number, send: () => Promise<T>): Promise<T> {
    const turn = this.queue.then(async () => {
      await this.waitFor(expectedCost)
      return send()
    })
    // A failed predecessor must not break the chain for everyone behind it, so
    // the stored link swallows rejections while the returned one does not.
    this.queue = turn.catch(() => undefined)
    return turn
  }

  /** Records the bucket as Shopify just described it. */
  observe(status: ThrottleStatus | undefined): void {
    if (!status || !(status.maximumAvailable > 0) || !(status.restoreRate > 0)) return
    this.known = { status, at: this.now() }
  }

  /**
   * Shopify said wait. Honoured exactly rather than rounded up to a default:
   * guessing longer wastes a merchant's sync window, guessing shorter earns
   * another refusal.
   */
  pauseFor(ms: number | undefined): void {
    const wait = ms === undefined || ms <= 0 ? UNSPECIFIED_RETRY_AFTER_MS : ms
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait)
  }

  /** How long a request of `cost` points would have to wait now, in milliseconds. */
  waitMsFor(cost: number): number {
    const now = this.now()
    const paused = Math.max(0, this.pausedUntil - now)
    if (!this.known) return paused
    const { status, at } = this.known
    const available = Math.min(
      status.maximumAvailable,
      status.currentlyAvailable + ((now - at) / 1000) * status.restoreRate,
    )
    // A request dearer than the whole unreserved half would otherwise wait
    // forever; it waits for a full bucket instead.
    const needed = Math.min(
      status.maximumAvailable,
      status.maximumAvailable * this.reservedShare + Math.max(0, cost),
    )
    const refill = available >= needed ? 0 : ((needed - available) / status.restoreRate) * 1000
    return Math.max(paused, Math.ceil(refill))
  }

  private async waitFor(cost: number): Promise<void> {
    const wait = this.waitMsFor(cost)
    if (wait > 0) await this.sleep(wait)
  }
}

/**
 * One limiter per store, kept for the life of the client.
 *
 * Without this the limiter would be per call site, and the things that read a
 * store on the same night — the catalogue sync, the content inventory, a
 * publish — would each believe they were the only one talking to it.
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

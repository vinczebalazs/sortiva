import { PREVIEW_RATE_LIMITS } from './limits'

/**
 * Per-IP rate limits and a global cap on how many outbound scrapes we will have
 * in flight at once.
 *
 * In-process, deliberately: v1 runs as a single service with no Redis, and a
 * database round trip per public request to count requests would make the
 * counter cost more than the thing it protects. The
 * limits are a cost guard behind Turnstile and the 7-day cache, not an
 * authorisation boundary — see DECISIONS 2026-09-01 T1.3 for what changes if
 * the app is ever run on more than one instance.
 */

export type RateLimitScope = 'ip_minute' | 'ip_day'

export interface RateLimitDecision {
  readonly allowed: boolean
  readonly scope?: RateLimitScope
  /** Seconds until the offending window frees a slot; the 429's `Retry-After`. */
  readonly retryAfterSeconds?: number
}

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * 60 * 1000

/** Entries older than a day are dead weight; sweep when the table gets big rather than on a timer. */
const SWEEP_THRESHOLD = 10_000

export interface PreviewRateLimiterOptions {
  perIpPerMinute?: number
  perIpPerDay?: number
  now?: () => number
}

export class PreviewRateLimiter {
  private readonly perMinute: number
  private readonly perDay: number
  private readonly now: () => number
  /** Request timestamps per IP, oldest first. One array serves both windows. */
  private readonly hits = new Map<string, number[]>()

  constructor(options: PreviewRateLimiterOptions = {}) {
    this.perMinute = options.perIpPerMinute ?? PREVIEW_RATE_LIMITS.perIpPerMinute
    this.perDay = options.perIpPerDay ?? PREVIEW_RATE_LIMITS.perIpPerDay
    this.now = options.now ?? Date.now
  }

  /** Checks and, when allowed, records. One call per request. */
  check(ip: string): RateLimitDecision {
    const now = this.now()
    const recent = (this.hits.get(ip) ?? []).filter((at) => now - at < DAY_MS)

    const inLastMinute = recent.filter((at) => now - at < MINUTE_MS)
    if (inLastMinute.length >= this.perMinute) {
      this.hits.set(ip, recent)
      return {
        allowed: false,
        scope: 'ip_minute',
        retryAfterSeconds: secondsUntilFree(inLastMinute[0] as number, MINUTE_MS, now),
      }
    }
    if (recent.length >= this.perDay) {
      this.hits.set(ip, recent)
      return {
        allowed: false,
        scope: 'ip_day',
        retryAfterSeconds: secondsUntilFree(recent[0] as number, DAY_MS, now),
      }
    }

    recent.push(now)
    this.hits.set(ip, recent)
    if (this.hits.size > SWEEP_THRESHOLD) this.sweep(now)
    return { allowed: true }
  }

  private sweep(now: number): void {
    for (const [ip, times] of this.hits) {
      const live = times.filter((at) => now - at < DAY_MS)
      if (live.length === 0) this.hits.delete(ip)
      else this.hits.set(ip, live)
    }
  }

  /** Test and ops visibility: how many distinct IPs are being tracked. */
  get trackedIps(): number {
    return this.hits.size
  }
}

function secondsUntilFree(oldest: number, windowMs: number, now: number): number {
  return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
}

/**
 * The global cap on outbound scrapes in flight. Non-blocking on purpose: a full
 * pool answers with the graceful generic card rather than queueing a public
 * request behind other people's scrapes.
 */
export class OutboundScrapeCap {
  private inFlight = 0

  constructor(private readonly limit: number = PREVIEW_RATE_LIMITS.globalConcurrentFetches) {}

  /** Returns a release function, or undefined when the cap is full. */
  acquire(): (() => void) | undefined {
    if (this.inFlight >= this.limit) return undefined
    this.inFlight += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.inFlight -= 1
    }
  }

  get active(): number {
    return this.inFlight
  }
}

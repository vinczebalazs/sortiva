/**
 * A bot-challenge token is required on every preview request, and it is verified
 * server-side **before any fetch happens** — a check that runs after we have
 * already paid for a scrape is not a cost control.
 *
 * Turnstile is Cloudflare's anti-bot check: the browser solves a challenge and
 * hands the page a one-time token, which we post back to Cloudflare to confirm.
 * It is the first of the three cost controls on the public preview endpoint
 * (the other two are the rate limits and the 7-day cache), and it is the one
 * that has to run first, because everything after it costs money.
 *
 * Behind an interface with a test double, like every other vendor (CLAUDE.md
 * plumbing rules): no Turnstile credentials exist yet, so the preview's own
 * tests run against `MockTurnstile`.
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** A hung siteverify must not hold a public request open; Cloudflare answers in tens of ms. */
const VERIFY_TIMEOUT_MS = 5_000

export interface TurnstileVerification {
  readonly success: boolean
  /** Cloudflare's `error-codes`, e.g. `invalid-input-response`, `timeout-or-duplicate`. */
  readonly errorCodes: readonly string[]
}

export interface TurnstileVerifier {
  verify(token: string, remoteIp?: string): Promise<TurnstileVerification>
}

/** Thrown at construction, not at request time, so a missing secret is an ops failure and not a silent bypass. */
export class TurnstileNotConfigured extends Error {
  constructor() {
    super('TURNSTILE_SECRET_KEY is not set; the preview endpoint cannot verify visitors.')
    this.name = 'TurnstileNotConfigured'
  }
}

export interface CloudflareTurnstileOptions {
  secretKey?: string
  endpoint?: string
  timeoutMs?: number
}

export class CloudflareTurnstile implements TurnstileVerifier {
  private readonly secretKey: string
  private readonly endpoint: string
  private readonly timeoutMs: number

  constructor(options: CloudflareTurnstileOptions = {}) {
    const secretKey = options.secretKey ?? process.env.TURNSTILE_SECRET_KEY
    if (!secretKey) throw new TurnstileNotConfigured()
    this.secretKey = secretKey
    this.endpoint = options.endpoint ?? SITEVERIFY_URL
    this.timeoutMs = options.timeoutMs ?? VERIFY_TIMEOUT_MS
  }

  async verify(token: string, remoteIp?: string): Promise<TurnstileVerification> {
    const body = new URLSearchParams({ secret: this.secretKey, response: token })
    if (remoteIp) body.set('remoteip', remoteIp)

    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch {
      // Cloudflare unreachable is a failed verification, never a pass: the whole
      // point of the check is that it gates the spend behind it.
      return { success: false, errorCodes: ['verification-unreachable'] }
    }

    if (!response.ok) {
      return { success: false, errorCodes: [`http-${response.status}`] }
    }

    const payload = (await response.json()) as {
      success?: boolean
      'error-codes'?: string[]
    }
    return {
      success: payload.success === true,
      errorCodes: payload['error-codes'] ?? [],
    }
  }
}

/**
 * Test double. Defaults to accepting, because most tests are about what happens
 * *after* the check; `reject()` and `rejectOnce()` drive the failure paths.
 */
export class MockTurnstile implements TurnstileVerifier {
  /** Every (token, ip) pair verified, in order. Lets a test assert the check ran before the fetch. */
  readonly verified: { token: string; remoteIp?: string }[] = []

  private outcome: TurnstileVerification = { success: true, errorCodes: [] }
  private readonly queued: TurnstileVerification[] = []

  reject(errorCodes: readonly string[] = ['invalid-input-response']): this {
    this.outcome = { success: false, errorCodes }
    return this
  }

  accept(): this {
    this.outcome = { success: true, errorCodes: [] }
    return this
  }

  rejectOnce(errorCodes: readonly string[] = ['timeout-or-duplicate']): this {
    this.queued.push({ success: false, errorCodes })
    return this
  }

  get callCount(): number {
    return this.verified.length
  }

  reset(): void {
    this.verified.length = 0
    this.queued.length = 0
    this.outcome = { success: true, errorCodes: [] }
  }

  async verify(token: string, remoteIp?: string): Promise<TurnstileVerification> {
    this.verified.push(remoteIp === undefined ? { token } : { token, remoteIp })
    return this.queued.shift() ?? this.outcome
  }
}

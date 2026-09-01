/**
 * One HTTP client, guarded against being pointed at our own network, serves
 * **every** page fetch the product makes.
 *
 * Its consumers are the preview card, the persona's homepage read, the draft
 * judge's competitor content and intent-gap analysis. They share this interface
 * so the guard is one implementation rather than four, and so a later card
 * cannot quietly ship a second, weaker fetch path.
 */

/** What one fetch may cost us: how long it may take, how much it may download, and how far it may be redirected. */
export interface FetchBudget {
  readonly timeoutMs: number
  readonly maxBytes: number
  readonly maxRedirects: number
}

export interface PageFetchRequest {
  readonly url: string
  /** Overrides for a caller with a different budget; the guard itself is never overridable. */
  readonly budget?: Partial<FetchBudget>
}

export interface PageFetchResult {
  /** The URL that actually served the body, after any redirects. */
  readonly finalUrl: string
  readonly status: number
  readonly contentType: string
  readonly body: string
  readonly bytes: number
  /** Every URL in the redirect chain, the requested one first. */
  readonly chain: readonly string[]
}

/**
 * Why a fetch was refused. Every reason is a distinct value so a caller can
 * tell "this site blocked us" from "this URL was an attack" — and so the
 * preview's graceful generic card can be served for the former
 * without ever hiding the latter from the logs.
 */
export type PageFetchReason =
  | 'blocked_scheme'
  | 'blocked_port'
  | 'blocked_userinfo'
  | 'blocked_hostname'
  | 'blocked_address'
  | 'dns_failure'
  | 'too_many_redirects'
  | 'redirect_without_location'
  | 'response_too_large'
  | 'timeout'
  | 'http_status'
  | 'unsupported_content_type'
  | 'transport'

/** Reasons that mean "someone aimed this at our own network", not "the site was slow". */
export const SSRF_REASONS: readonly PageFetchReason[] = [
  'blocked_scheme',
  'blocked_port',
  'blocked_userinfo',
  'blocked_hostname',
  'blocked_address',
]

export class PageFetchError extends Error {
  override readonly name = 'PageFetchError'

  constructor(
    readonly reason: PageFetchReason,
    message: string,
    /** The URL the refusal is about — the redirect target, not the original, when a hop was blocked. */
    readonly url?: string,
  ) {
    super(message)
  }

  /** True when the refusal was the guard firing rather than the remote site behaving badly. */
  get isSsrfBlock(): boolean {
    return SSRF_REASONS.includes(this.reason)
  }
}

export interface PageFetcher {
  fetch(request: PageFetchRequest): Promise<PageFetchResult>
}

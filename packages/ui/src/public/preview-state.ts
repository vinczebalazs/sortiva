/**
 * What the visitor sees after they paste their site address.
 *
 * The preview exists to turn a curious stranger into a signed-up merchant, so
 * it is never allowed to dead-end: there is no error state at all. A site we
 * could not read, a spend cap that has tripped, an endpoint that is down and a
 * browser that lost its connection all land on the same generic card, which
 * carries the same invitation to sign up as a successful one. The single
 * exception is being rate-limited, which has its own line because "try again in
 * a minute" is advice the visitor can act on.
 */

export type PreviewState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly typed: string }
  /** The two-to-three sentence summary of what the business does. */
  | { readonly kind: 'result'; readonly domain: string; readonly summary: string }
  | { readonly kind: 'generic'; readonly domain: string }
  | { readonly kind: 'rate_limited' }

/** The shape `POST /api/preview` answers with. */
export interface PreviewResponseBody {
  readonly domain: string
  readonly summary: string | null
  readonly cacheHit: boolean
  readonly generic: boolean
}

/**
 * What actually came back. `unreachable` covers the cases where there is no
 * HTTP answer to read — the request threw, or the body was not the JSON we
 * expect.
 */
export type PreviewOutcome =
  | { readonly kind: 'answered'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'unreachable' }

/** HTTP 429: the per-IP limits in front of the endpoint said no. */
export const RATE_LIMITED_STATUS = 429

export function previewStateFrom(outcome: PreviewOutcome, typed: string): PreviewState {
  if (outcome.kind === 'unreachable') return { kind: 'generic', domain: typed }
  if (outcome.status === RATE_LIMITED_STATUS) return { kind: 'rate_limited' }

  const body = asResponseBody(outcome.body)
  if (!body) return { kind: 'generic', domain: typed }
  if (outcome.status !== 200 || body.generic || body.summary === null) {
    return { kind: 'generic', domain: body.domain || typed }
  }
  return { kind: 'result', domain: body.domain, summary: body.summary }
}

function asResponseBody(value: unknown): PreviewResponseBody | null {
  if (value === null || typeof value !== 'object') return null
  const candidate = value as Partial<PreviewResponseBody>
  if (typeof candidate.domain !== 'string') return null
  if (typeof candidate.summary !== 'string' && candidate.summary !== null) return null
  if (typeof candidate.generic !== 'boolean') return null
  return {
    domain: candidate.domain,
    summary: candidate.summary,
    cacheHit: candidate.cacheHit === true,
    generic: candidate.generic,
  }
}

/**
 * Whether there is anything worth sending. The address itself is normalised
 * server-side — a merchant typing `yourstore.com`, `www.yourstore.com` or a full
 * URL must all work — so the only thing checked here is that they typed
 * something.
 */
export function isSubmittable(typed: string): boolean {
  return typed.trim().length > 0
}

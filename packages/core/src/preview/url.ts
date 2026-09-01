import { normaliseClaimDomain } from '../domain/normalise'
/**
 * main §3.2 — "cache key = normalized domain".
 *
 * This is the preview's own normalisation and it is deliberately weaker than
 * the one the domain *claim* needs (main §2, §5: eTLD+1 via the Public Suffix
 * List, so `shop.example.co.uk` and `example.co.uk` are one account). That
 * stricter normaliser belongs to T1.4 and lives in `packages/core/domain`.
 *
 * The difference matters and is intentional: a claim folds subdomains together
 * because an account owns a business, whereas a preview must fetch the exact
 * site the visitor pasted — folding `shop.example.com` into `example.com` would
 * show a stranger a card about a different website. See DECISIONS 2026-09-01.
 */

export class InvalidPreviewUrl extends Error {
  constructor(readonly input: string, reason: string) {
    super(`Not a usable site address: ${reason}`)
    this.name = 'InvalidPreviewUrl'
  }
}

export interface NormalisedPreviewTarget {
  /** The `preview_cache` key and the `target_domain` event property (main §14.7). */
  readonly domain: string
  /**
   * The registrable domain behind `domain` — what this business would claim at
   * signup, resolved with the same normaliser the claim itself uses, so the two
   * agree by construction rather than by coincidence. Spend is recorded against
   * this so preview costs join to the account that later signs up.
   *
   * Falls back to `domain` when the claim normaliser cannot resolve one: the
   * preview accepts addresses the claim would reject, and an unjoinable spend
   * row is better than an unrecorded one.
   */
  readonly billableDomain: string
  /** main §3.3 step 1 — "fetch homepage HTML", whatever path was pasted. */
  readonly homepageUrl: string
}

/**
 * Accepts what a visitor actually types into a landing-page box: a bare domain,
 * a full URL, mixed case, a `www.` prefix, a trailing path.
 */
export function normalisePreviewUrl(input: string): NormalisedPreviewTarget {
  const trimmed = input.trim()
  if (trimmed === '') throw new InvalidPreviewUrl(input, 'it is empty')
  if (trimmed.length > 2_000) throw new InvalidPreviewUrl(input, 'it is too long')

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new InvalidPreviewUrl(input, 'it is not a web address')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidPreviewUrl(input, 'only http and https addresses can be previewed')
  }
  if (url.username !== '' || url.password !== '') {
    throw new InvalidPreviewUrl(input, 'it carries a username or password')
  }

  let host = url.hostname.toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) {
    throw new InvalidPreviewUrl(input, 'it is an IPv6 address rather than a site')
  }
  while (host.endsWith('.')) host = host.slice(0, -1)
  if (host.startsWith('www.')) host = host.slice(4)

  if (!host.includes('.')) throw new InvalidPreviewUrl(input, 'it has no domain name')
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes('..') || host.startsWith('-')) {
    throw new InvalidPreviewUrl(input, 'the domain name is malformed')
  }

  // A non-standard port is not part of a site's identity and main §3.2 permits
  // only 80/443 anyway; dropping it here keeps one cache key per site.
  return { domain: host, billableDomain: billableFor(host), homepageUrl: `https://${host}/` }
}

/** main §3.3 step 4 — a second fetch, on the same host, at one of the known about paths. */
export function aboutUrl(domain: string, path: string): string {
  return `https://${domain}${path}`
}

/**
 * The registrable domain a preview's spend should be attributed to. Uses the
 * claim's own normaliser so preview spend and the later claim land on the same
 * key; falls back to the exact host when it cannot resolve one, since recording
 * spend matters more than being able to join it.
 */
function billableFor(host: string): string {
  try {
    return normaliseClaimDomain(host).normalized
  } catch {
    return host
  }
}

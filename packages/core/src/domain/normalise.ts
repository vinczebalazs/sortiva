import { parse } from 'tldts'

/**
 * main §2 "Domain normalization (used everywhere a domain is stored or
 * compared): lowercase, strip scheme, strip `www.`, strip path/query/fragment,
 * resolve to the registrable domain (eTLD+1) using the Public Suffix List …
 * we claim at **eTLD+1** level so a user can't claim `blog.example.com` while
 * another claims `shop.example.com` — same business, one account."
 *
 * This is invariant 1's first half: the value the unique index is taken over.
 * Two spellings of one business must produce one string here, or the database
 * cannot enforce anything.
 *
 * Deliberately *not* the preview's normaliser (`packages/core/src/preview/url.ts`),
 * which keeps subdomains because it fetches the exact site a stranger pasted.
 * See DECISIONS 2026-09-01 T1.3.
 */

export class InvalidClaimDomain extends Error {
  constructor(
    readonly input: string,
    readonly reason: string,
  ) {
    super(`Not a claimable domain: ${reason}`)
    this.name = 'InvalidClaimDomain'
  }
}

/**
 * main §2 — "Subdomain edge cases (genuinely separate businesses on subdomains,
 * e.g. `*.myshopify.com` — see §6.1) are handled by allowlisting known
 * multi-tenant suffixes into the PSL logic."
 *
 * An explicit list, not the Public Suffix List's own PRIVATE section. That
 * section carries thousands of entries — `github.io`, `blogspot.com`,
 * `s3.amazonaws.com` — and turning it on wholesale would silently change how
 * every one of them is claimed. Every entry here is a platform whose tenants
 * are genuinely separate businesses; adding one is a code change, on purpose.
 */
export const MULTI_TENANT_SUFFIXES: readonly string[] = ['myshopify.com']

export interface NormalisedClaim {
  /** `domains.domain_normalized` — the value the global unique index is on. */
  readonly normalized: string
  /** The full host as typed, after case/`www.`/port cleanup. Kept for the error copy. */
  readonly host: string
}

/**
 * Accepts what a merchant types into ui §3.1's box: a bare domain, a full URL,
 * mixed case, a `www.` prefix, a path.
 *
 * Throws `InvalidClaimDomain` for ui §3.1's "invalid/unresolvable domain" error
 * state. This does no DNS lookup: unreachability is discovered by the `detect`
 * step (main §6.1), not by the claim.
 */
export function normaliseClaimDomain(input: string): NormalisedClaim {
  const trimmed = input.trim()
  if (trimmed === '') throw new InvalidClaimDomain(input, 'it is empty')
  if (trimmed.length > 2_000) throw new InvalidClaimDomain(input, 'it is too long')

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new InvalidClaimDomain(input, 'it is not a web address')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidClaimDomain(input, 'only http and https addresses can be connected')
  }
  if (url.username !== '' || url.password !== '') {
    throw new InvalidClaimDomain(input, 'it carries a username or password')
  }

  // `URL` lowercases the host and punycodes an internationalised one, so
  // `CAFÉ.example.com` and `xn--caf-dma.example.com` normalise to one string.
  let host = url.hostname
  if (host.startsWith('[') && host.endsWith(']')) {
    throw new InvalidClaimDomain(input, 'it is an IP address rather than a domain')
  }
  while (host.endsWith('.')) host = host.slice(0, -1)
  // Redundant against the eTLD+1 resolution below, which drops every subdomain
  // including `www`. Kept because main §2 names it as a step, and because it is
  // what makes a bare `www.myshopify.com` fall into the check under it.
  if (host.startsWith('www.')) host = host.slice(4)

  if (host === '') throw new InvalidClaimDomain(input, 'it has no domain name')

  const parsed = parse(host, { allowPrivateDomains: false })
  if (parsed.isIp) throw new InvalidClaimDomain(input, 'it is an IP address rather than a domain')

  const multiTenant = MULTI_TENANT_SUFFIXES.find(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  )
  if (multiTenant) {
    if (host === multiTenant) {
      throw new InvalidClaimDomain(input, `${multiTenant} is a platform, not a store`)
    }
    // One label in front of the platform suffix: `foo.bar.myshopify.com` and
    // `bar.myshopify.com` are the same tenant, exactly as eTLD+1 treats
    // `shop.example.com` and `example.com`.
    const labels = host.slice(0, -(multiTenant.length + 1)).split('.')
    const tenant = labels[labels.length - 1]
    if (!tenant) throw new InvalidClaimDomain(input, 'the domain name is malformed')
    return { normalized: `${tenant}.${multiTenant}`, host }
  }

  // `isIcann` is false for a suffix the Public Suffix List does not contain —
  // `example.con`, a typo'd TLD. Claiming it would park an account on a domain
  // that can never resolve, so it is ui §3.1's "invalid domain" instead.
  if (!parsed.domain || !parsed.isIcann) {
    throw new InvalidClaimDomain(input, 'that is not a domain name we recognise')
  }

  return { normalized: parsed.domain, host }
}

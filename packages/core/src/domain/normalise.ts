import { parse } from 'tldts'

/**
 * Domain normalisation, used everywhere a domain is stored or compared:
 * lowercase, strip the scheme, strip `www.`, strip path, query and fragment,
 * then resolve to the registrable domain using the Public Suffix List.
 *
 * We claim at the registrable domain so one person cannot claim
 * `blog.example.com` while another claims `shop.example.com` — same business,
 * one account.
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
 * Some subdomains really are separate businesses — every store on
 * `*.myshopify.com` is a different merchant — so those suffixes are allowlisted
 * and claimed one level deeper.
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
 * Accepts whatever a merchant types into the box: a bare domain, a full URL,
 * mixed case, a `www.` prefix, a path.
 *
 * Throws `InvalidClaimDomain` for the inline "that is not a website address"
 * error. This does no DNS lookup — whether the site is actually reachable is
 * discovered later by the detect step, not by the claim.
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
  // including `www`. Kept because it is what makes a bare `www.myshopify.com`
  // fall into the multi-tenant check under it.
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
  // that can never resolve, so it is refused as an invalid domain instead.
  if (!parsed.domain || !parsed.isIcann) {
    throw new InvalidClaimDomain(input, 'that is not a domain name we recognise')
  }

  return { normalized: parsed.domain, host }
}

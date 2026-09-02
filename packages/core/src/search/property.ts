/**
 * Which Search Console property belongs to the store we are working for.
 *
 * A Google account can read properties for sites the merchant has nothing to do
 * with — an agency's, a personal blog, a client they no longer have. Picking the
 * wrong one is not a small mistake: every opportunity the engine finds would be
 * about somebody else's website, and nothing downstream could tell. So the
 * property's host must be the claimed domain or sit underneath it, and a
 * mismatch is refused rather than warned about.
 */

/** Google's two property kinds. A domain property covers every subdomain and protocol; a URL-prefix property covers one exact prefix. */
export type GscPropertyKind = 'domain' | 'url_prefix'

export interface ParsedGscProperty {
  readonly kind: GscPropertyKind
  /** Lowercased, no trailing dot, no `www.` — comparable to a claimed domain. */
  readonly host: string
}

const DOMAIN_PREFIX = 'sc-domain:'

/**
 * Reads the host out of either property form. Returns null when the string is
 * neither — which for us means a property Google described in a way we do not
 * understand, and therefore one we will not let anybody select.
 */
export function parseGscProperty(siteUrl: string): ParsedGscProperty | null {
  const value = siteUrl.trim()
  if (value === '') return null

  if (value.toLowerCase().startsWith(DOMAIN_PREFIX)) {
    const host = cleanHost(value.slice(DOMAIN_PREFIX.length))
    return host ? { kind: 'domain', host } : null
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = cleanHost(url.hostname)
  return host ? { kind: 'url_prefix', host } : null
}

function cleanHost(raw: string): string | null {
  let host = raw.trim().toLowerCase()
  while (host.endsWith('.')) host = host.slice(0, -1)
  if (host.startsWith('www.')) host = host.slice(4)
  if (host === '' || host.includes('/') || host.includes(' ')) return null
  return host
}

/**
 * True when the property covers the store we claimed: the same domain, or a
 * subdomain of it. `claimedDomain` is the normalised registrable domain the
 * account holds — the same string the uniqueness of accounts is decided on.
 */
export function propertyMatchesClaimedDomain(siteUrl: string, claimedDomain: string): boolean {
  const parsed = parseGscProperty(siteUrl)
  if (!parsed) return false
  const claimed = claimedDomain.trim().toLowerCase()
  if (claimed === '') return false
  return parsed.host === claimed || parsed.host.endsWith(`.${claimed}`)
}

export interface GscPropertyChoice {
  readonly siteUrl: string
  readonly permissionLevel: string
  readonly matchesClaimedDomain: boolean
}

/** Flags each property the merchant could pick, so the picker can say why one is not selectable before they submit. */
export function annotateProperties(
  sites: readonly { siteUrl: string; permissionLevel: string }[],
  claimedDomain: string,
): GscPropertyChoice[] {
  return sites.map((site) => ({
    siteUrl: site.siteUrl,
    permissionLevel: site.permissionLevel,
    matchesClaimedDomain: propertyMatchesClaimedDomain(site.siteUrl, claimedDomain),
  }))
}

import { isIP } from 'node:net'
import { PageFetchError } from './types'

/**
 * The SSRF policy, as pure functions over strings: ports 80 and 443 only, and
 * private or reserved IP ranges blocked **after DNS resolution**.
 *
 * "SSRF" is server-side request forgery: a visitor hands us a URL that points
 * at our own private network or at a cloud provider's metadata service, and a
 * naive fetcher obediently retrieves it and hands back the contents. Three
 * things have to hold for the guard to be real, and each is separated out here
 * so it can be tested on its own:
 *
 *  1. **The URL itself must be admissible** — http/https, port 80 or 443, no
 *     embedded credentials. `parseTarget`.
 *  2. **Every address the hostname resolves to must be public** — checked after
 *     resolution, because `internal.example.com` is a perfectly ordinary
 *     hostname that resolves to `10.0.0.1`. `classifyAddress`.
 *  3. **Both checks re-run on every redirect hop**, because a public URL that
 *     302s to `http://169.254.169.254/` is the same attack wearing a suit. The
 *     fetcher enforces that by calling back into these functions per hop.
 *
 * Notations that disguise a private address (`http://2130706433/`,
 * `http://0177.0.0.1/`, `http://127.1/`, `http://[::ffff:127.0.0.1]/`) are not
 * handled by a blocklist of spellings — that game cannot be won. The WHATWG URL
 * parser canonicalises all of them to a dotted quad or a bracketed IPv6
 * literal, and `classifyAddress` then works on the canonical form. The tests
 * assert the canonicalisation as well as the verdict, so a change in Node's
 * parser cannot silently open a hole.
 */

export type AddressCategory =
  | 'public'
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'cgnat'
  | 'link_local'
  | 'metadata'
  | 'multicast'
  | 'reserved'
  | 'documentation'
  | 'benchmark'
  | 'unique_local'
  | 'tunnel'
  | 'discard'
  | 'malformed'

export interface AddressVerdict {
  readonly category: AddressCategory
  readonly blocked: boolean
  /** The address the verdict is really about — an IPv4-mapped or 6to4 address is judged on the IPv4 inside it. */
  readonly effective: string
}

/**
 * What a fetch may connect to: which address categories, and which ports.
 * Production uses `PUBLIC_ONLY` — public addresses, ports 80 and 443, and
 * nothing else.
 *
 * The seam exists so the integration tests can run a real HTTP server on
 * loopback and an ephemeral port; see `testing.ts`, which is the only other
 * producer of a policy and is never imported by production code. A test asserts
 * that `PUBLIC_ONLY` refuses that same server, so the carve-out is provably the
 * only difference.
 */
export interface FetchPolicy {
  readonly name: string
  readonly allowedCategories: ReadonlySet<AddressCategory>
  readonly allowedPorts: ReadonlySet<number>
}

export const PUBLIC_ONLY: FetchPolicy = {
  name: 'public-only',
  allowedCategories: new Set<AddressCategory>(['public']),
  allowedPorts: new Set<number>([80, 443]),
}

/** WHATWG-canonical hostnames that never reach a public address. Defence in depth: the address check is the guarantee. */
const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.onion']
const BLOCKED_HOSTNAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback'])

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

export interface FetchTarget {
  readonly url: URL
  /** Hostname with IPv6 brackets stripped and the trailing root dot removed. */
  readonly host: string
  /** 4, 6, or 0 when the host is a name rather than an address literal. */
  readonly literalFamily: 0 | 4 | 6
  readonly port: number
}

/**
 * Step 1 of the guard. Throws `PageFetchError` with an SSRF reason rather than
 * returning a verdict, because there is no caller that wants to continue.
 */
export function parseTarget(
  raw: string,
  base?: string,
  policy: FetchPolicy = PUBLIC_ONLY,
): FetchTarget {
  let url: URL
  try {
    url = base === undefined ? new URL(raw) : new URL(raw, base)
  } catch {
    throw new PageFetchError('blocked_hostname', `Not a parseable absolute URL: ${raw}`, raw)
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    // Blocks file:, ftp:, gopher:, data:, and the redirect-to-scheme-downgrade trick.
    throw new PageFetchError('blocked_scheme', `Scheme ${url.protocol} is not fetchable.`, url.href)
  }

  if (url.username !== '' || url.password !== '') {
    throw new PageFetchError(
      'blocked_userinfo',
      'URL carries embedded credentials; we never send them.',
      url.href,
    )
  }

  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
  if (!policy.allowedPorts.has(port)) {
    throw new PageFetchError(
      'blocked_port',
      `Port ${port} is not permitted by policy ${policy.name}.`,
      url.href,
    )
  }

  const host = normaliseHost(url.hostname)
  if (host === '') {
    throw new PageFetchError('blocked_hostname', 'URL has no host.', url.href)
  }

  const literalFamily = isIP(host) as 0 | 4 | 6
  if (literalFamily === 0) {
    const lower = host.toLowerCase()
    if (BLOCKED_HOSTNAMES.has(lower) || BLOCKED_HOSTNAME_SUFFIXES.some((s) => lower.endsWith(s))) {
      throw new PageFetchError('blocked_hostname', `Hostname ${host} is not routable.`, url.href)
    }
  }

  return { url, host, literalFamily, port }
}

/** Strips IPv6 brackets and the DNS root dot, both of which are legal and both of which confuse comparisons. */
export function normaliseHost(hostname: string): string {
  let host = hostname
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  while (host.endsWith('.')) host = host.slice(0, -1)
  return host
}

/**
 * Step 2 of the guard, applied to every address DNS returned. Ranges are the
 * IANA special-purpose registries (RFC 5735 / RFC 6890 for IPv4, RFC 4193 /
 * RFC 4291 / RFC 6890 for IPv6) plus the cloud metadata address that motivates
 * the whole exercise (169.254.169.254).
 */
export function classifyAddress(address: string): AddressVerdict {
  const family = isIP(address)
  if (family === 4) return verdict(classifyIpv4(address), address)
  if (family === 6) return classifyIpv6(address)
  return { category: 'malformed', blocked: true, effective: address }
}

export function isAllowedAddress(address: string, policy: FetchPolicy = PUBLIC_ONLY): boolean {
  return policy.allowedCategories.has(classifyAddress(address).category)
}

/** Throws when the address is outside the policy. The message names the category so an incident report is readable. */
export function assertAllowedAddress(
  address: string,
  url: string,
  policy: FetchPolicy = PUBLIC_ONLY,
): void {
  const result = classifyAddress(address)
  if (policy.allowedCategories.has(result.category)) return
  throw new PageFetchError(
    'blocked_address',
    `${address} is ${result.category} (effective ${result.effective}); policy ${policy.name} allows only ${[...policy.allowedCategories].join(', ')}.`,
    url,
  )
}

function verdict(category: AddressCategory, effective: string): AddressVerdict {
  return { category, blocked: category !== 'public', effective }
}

function octets(address: string): [number, number, number, number] {
  const parts = address.split('.').map(Number)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 0]
}

function classifyIpv4(address: string): AddressCategory {
  const [a, b, c, d] = octets(address)

  // The address this guard exists for: AWS/GCP/Azure instance metadata.
  if (a === 169 && b === 254 && c === 169 && d === 254) return 'metadata'

  if (a === 0) return 'unspecified' // 0.0.0.0/8 "this network"
  if (a === 127) return 'loopback' // 127.0.0.0/8
  if (a === 10) return 'private' // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return 'private' // 172.16.0.0/12
  if (a === 192 && b === 168) return 'private' // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat' // 100.64.0.0/10
  if (a === 169 && b === 254) return 'link_local' // 169.254.0.0/16
  if (a === 192 && b === 0 && c === 0) return 'reserved' // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return 'documentation' // TEST-NET-1
  if (a === 198 && b === 51 && c === 100) return 'documentation' // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return 'documentation' // TEST-NET-3
  if (a === 192 && b === 88 && c === 99) return 'tunnel' // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return 'benchmark' // 198.18.0.0/15
  if (a >= 224 && a <= 239) return 'multicast' // 224.0.0.0/4
  if (a >= 240) return 'reserved' // 240.0.0.0/4, incl. 255.255.255.255

  return 'public'
}

function classifyIpv6(address: string): AddressVerdict {
  const lower = address.toLowerCase()
  const groups = expandIpv6(lower)
  if (groups === undefined) return { category: 'malformed', blocked: true, effective: address }

  // ::ffff:a.b.c.d — an IPv4 address wearing an IPv6 costume. Judge the IPv4.
  const mapped = mappedIpv4(groups)
  if (mapped !== undefined) return verdict(classifyIpv4(mapped), mapped)

  // 64:ff9b::/96 NAT64 and 2002::/16 6to4 both carry a routable IPv4 inside.
  if (groups[0] === 0x64 && groups[1] === 0xff9b) {
    const embedded = ipv4From(groups[6] ?? 0, groups[7] ?? 0)
    return verdict(classifyIpv4(embedded), embedded)
  }
  if (groups[0] === 0x2002) {
    const embedded = ipv4From(groups[1] ?? 0, groups[2] ?? 0)
    const inner = classifyIpv4(embedded)
    return verdict(inner === 'public' ? 'tunnel' : inner, embedded)
  }

  if (groups.every((g) => g === 0)) return verdict('unspecified', address) // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
    return verdict('loopback', address) // ::1
  }

  const first = groups[0] ?? 0
  if (first === 0x100 && groups.slice(1, 4).every((g) => g === 0)) {
    return verdict('discard', address) // 100::/64
  }
  if (first === 0x2001 && (groups[1] ?? 0) === 0x0db8) return verdict('documentation', address)
  if (first === 0x2001 && (groups[1] ?? 0) === 0x0000) return verdict('tunnel', address) // Teredo
  if ((first & 0xfe00) === 0xfc00) return verdict('unique_local', address) // fc00::/7
  if ((first & 0xffc0) === 0xfe80) return verdict('link_local', address) // fe80::/10
  if ((first & 0xff00) === 0xff00) return verdict('multicast', address) // ff00::/8

  return verdict('public', address)
}

/** Returns the eight 16-bit groups of an IPv6 address, or undefined when it will not parse. */
function expandIpv6(address: string): number[] | undefined {
  let text = address
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)

  // A trailing dotted quad (`::ffff:127.0.0.1`) becomes two hex groups first.
  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)
  if (dotted) {
    const quad = octets(dotted[1] ?? '')
    if (quad.some((n) => n > 255)) return undefined
    const hi = ((quad[0] << 8) | quad[1]).toString(16)
    const lo = ((quad[2] << 8) | quad[3]).toString(16)
    text = `${text.slice(0, dotted.index)}:${hi}:${lo}`
  }

  const halves = text.split('::')
  if (halves.length > 2) return undefined

  const head = halves[0] === '' ? [] : (halves[0] ?? '').split(':').filter((p) => p !== '')
  const tail = halves.length === 2 ? (halves[1] ?? '').split(':').filter((p) => p !== '') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0) return undefined

  const parts = [...head, ...Array<string>(fill).fill('0'), ...tail]
  if (parts.length !== 8) return undefined

  const groups = parts.map((p) => Number.parseInt(p, 16))
  if (groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return undefined
  return groups
}

function mappedIpv4(groups: number[]): string | undefined {
  const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff
  // ::a.b.c.d (deprecated IPv4-compatible) hides an IPv4 just as effectively.
  const isCompatible = groups.slice(0, 6).every((g) => g === 0) && (groups[6] ?? 0) !== 0
  if (!isMapped && !isCompatible) return undefined
  return ipv4From(groups[6] ?? 0, groups[7] ?? 0)
}

function ipv4From(hi: number, lo: number): string {
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.')
}

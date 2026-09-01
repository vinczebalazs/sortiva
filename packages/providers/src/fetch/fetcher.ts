import { lookup as dnsLookup } from 'node:dns'
import { promises as dns } from 'node:dns'
import { request as httpRequest, type IncomingMessage, type ClientRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupAddress } from 'node:dns'
import { assertAllowedAddress, parseTarget, PUBLIC_ONLY, type FetchPolicy } from './guard'
import {
  PageFetchError,
  type FetchBudget,
  type PageFetchRequest,
  type PageFetchResult,
  type PageFetcher,
} from './types'

/**
 * tech §2's single outbound page fetcher. main §3.2 sets its budget: "one page
 * fetch, hard timeout (~8s), max download size (~1.5 MB), follow at most 2
 * redirects, only ports 80/443, block private/reserved IP ranges after DNS
 * resolution".
 *
 * The interesting part is not the budget, it is the order of operations, so
 * here it is in full. For each hop:
 *
 *  1. `parseTarget` admits the URL (scheme, port, credentials, hostname).
 *  2. The hostname is resolved to **every** address it has.
 *  3. **All** of them are checked against the policy. One private address
 *     rejects the whole host — a name that answers with both a public and a
 *     private address is either broken or hostile, and picking the good one
 *     would leave the outcome up to resolver ordering.
 *  4. The connection is **pinned** to the exact address that was checked, by
 *     handing `node:http` a `lookup` that ignores the hostname and returns that
 *     address. Without this, the resolver runs a second time inside the socket
 *     layer and an attacker who controls the DNS answer can return a public
 *     address for our check and a private one for our connection — "DNS
 *     rebinding", the classic way a checked fetcher is defeated.
 *  5. After the socket connects, `remoteAddress` is checked again. Belt and
 *     braces: if anything between us and the kernel ever ignores step 4, the
 *     request is destroyed before a byte of the response is read.
 *  6. A redirect restarts at step 1 with the new URL. That is what stops a
 *     public URL that 302s to `http://169.254.169.254/`.
 *
 * Redirects are followed manually for exactly that reason — an HTTP client's
 * built-in redirect following would perform steps 2–5 without us.
 */

/** main §3.2. Callers may tighten these; the guard itself is not a parameter. */
export const DEFAULT_FETCH_BUDGET: FetchBudget = {
  timeoutMs: 8_000,
  maxBytes: 1_500_000,
  maxRedirects: 2,
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** Cheap extraction (main §3.3) reads markup and text; anything else is a wasted download. */
const FETCHABLE_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'application/xml',
  'text/xml',
]

export type HostResolver = (hostname: string) => Promise<readonly string[]>

export interface GuardedPageFetcherOptions {
  /** Defaults to `PUBLIC_ONLY`. The only other producer is `testing.ts`. */
  policy?: FetchPolicy
  /** Injected by tests. Production resolves through the system resolver. */
  resolve?: HostResolver
  budget?: Partial<FetchBudget>
  userAgent?: string
}

export class GuardedPageFetcher implements PageFetcher {
  private readonly policy: FetchPolicy
  private readonly resolve: HostResolver
  private readonly budget: FetchBudget
  private readonly userAgent: string

  constructor(options: GuardedPageFetcherOptions = {}) {
    this.policy = options.policy ?? PUBLIC_ONLY
    this.resolve = options.resolve ?? systemResolver
    this.budget = { ...DEFAULT_FETCH_BUDGET, ...options.budget }
    this.userAgent = options.userAgent ?? 'SortivaBot/1.0 (+https://sortiva.com/bot)'
  }

  async fetch(request: PageFetchRequest): Promise<PageFetchResult> {
    const budget: FetchBudget = { ...this.budget, ...request.budget }
    const deadline = Date.now() + budget.timeoutMs
    const chain: string[] = []

    let current = request.url
    let base: string | undefined

    for (let hop = 0; hop <= budget.maxRedirects; hop += 1) {
      const target = parseTarget(current, base, this.policy)
      chain.push(target.url.href)

      const address = await this.pinnedAddress(target.host, target.literalFamily, target.url.href)
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new PageFetchError('timeout', `Exceeded ${budget.timeoutMs}ms.`, target.url.href)
      }

      const hopResult = await this.hop(target.url, address, remaining, budget, this.userAgent)

      if (!REDIRECT_STATUSES.has(hopResult.status)) {
        return {
          finalUrl: target.url.href,
          status: hopResult.status,
          contentType: hopResult.contentType,
          body: hopResult.body,
          bytes: hopResult.bytes,
          chain,
        }
      }

      if (hopResult.location === undefined) {
        throw new PageFetchError(
          'redirect_without_location',
          `${hopResult.status} with no Location header.`,
          target.url.href,
        )
      }
      base = target.url.href
      current = hopResult.location
    }

    throw new PageFetchError(
      'too_many_redirects',
      `More than ${budget.maxRedirects} redirects.`,
      chain[chain.length - 1],
    )
  }

  /**
   * Resolves the hostname and returns the single address the connection will be
   * pinned to. Throws if *any* address the host answers with is out of policy.
   */
  private async pinnedAddress(host: string, literalFamily: 0 | 4 | 6, url: string): Promise<string> {
    if (literalFamily !== 0) {
      assertAllowedAddress(host, url, this.policy)
      return host
    }

    let addresses: readonly string[]
    try {
      addresses = await this.resolve(host)
    } catch {
      throw new PageFetchError('dns_failure', `Could not resolve ${host}.`, url)
    }
    if (addresses.length === 0) {
      throw new PageFetchError('dns_failure', `${host} resolved to no addresses.`, url)
    }
    for (const address of addresses) {
      assertAllowedAddress(address, url, this.policy)
    }
    return addresses[0] as string
  }

  private hop(
    url: URL,
    address: string,
    timeoutMs: number,
    budget: FetchBudget,
    userAgent: string,
  ): Promise<HopResult> {
    const policy = this.policy
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest

    return new Promise<HopResult>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        req.destroy()
        fn()
      }

      const timer = setTimeout(() => {
        finish(() => reject(new PageFetchError('timeout', `Exceeded ${timeoutMs}ms.`, url.href)))
      }, timeoutMs)

      const req: ClientRequest = send(
        {
          protocol: url.protocol,
          host: url.hostname,
          port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          // Step 4: the socket layer never resolves the hostname itself.
          lookup: pinnedLookup(address),
          // A pooled socket is keyed by host and port, not by the pinned
          // address; a fresh socket per hop keeps the pinning honest.
          agent: false,
          servername: url.hostname,
          headers: {
            host: url.host,
            'user-agent': userAgent,
            accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
            // No compression: the byte cap must count bytes we would have to
            // hold, and a decompressing client turns a 1 MB cap into a zip bomb.
            'accept-encoding': 'identity',
          },
        },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0

          if (REDIRECT_STATUSES.has(status)) {
            const location = firstHeader(res.headers.location)
            res.resume()
            finish(() => resolve({ status, contentType: '', body: '', bytes: 0, location }))
            return
          }

          if (status < 200 || status >= 400) {
            res.resume()
            finish(() =>
              reject(new PageFetchError('http_status', `Remote answered ${status}.`, url.href)),
            )
            return
          }

          const contentType = firstHeader(res.headers['content-type']) ?? ''
          if (!isFetchableContentType(contentType)) {
            res.resume()
            finish(() =>
              reject(
                new PageFetchError(
                  'unsupported_content_type',
                  `Content-Type ${contentType || '(none)'} is not a page.`,
                  url.href,
                ),
              ),
            )
            return
          }

          const declared = Number(firstHeader(res.headers['content-length']) ?? NaN)
          if (Number.isFinite(declared) && declared > budget.maxBytes) {
            res.resume()
            finish(() =>
              reject(
                new PageFetchError(
                  'response_too_large',
                  `Content-Length ${declared} exceeds ${budget.maxBytes}.`,
                  url.href,
                ),
              ),
            )
            return
          }

          const chunks: Buffer[] = []
          let bytes = 0
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length
            if (bytes > budget.maxBytes) {
              // The cap is enforced on the wire, not after the fact: a server
              // that lies in Content-Length still cannot make us hold 1 GB.
              finish(() =>
                reject(
                  new PageFetchError(
                    'response_too_large',
                    `Body exceeded ${budget.maxBytes} bytes.`,
                    url.href,
                  ),
                ),
              )
              return
            }
            chunks.push(chunk)
          })
          res.on('end', () => {
            const buffer = Buffer.concat(chunks)
            finish(() =>
              resolve({
                status,
                contentType,
                body: buffer.toString(charsetOf(contentType)),
                bytes: buffer.length,
              }),
            )
          })
          res.on('error', (cause) => {
            finish(() => reject(transportError(cause, url.href)))
          })
        },
      )

      req.on('socket', (socket) => {
        // Step 5. `connect` fires once the peer is known; on a reused or
        // already-connected socket `remoteAddress` is set immediately.
        const verify = (): void => {
          const remote = socket.remoteAddress
          if (remote === undefined) return
          try {
            assertAllowedAddress(remote, url.href, policy)
          } catch (error) {
            finish(() => reject(error))
          }
        }
        if (socket.remoteAddress !== undefined) verify()
        socket.on('connect', verify)
      })

      req.on('error', (cause) => {
        finish(() => reject(transportError(cause, url.href)))
      })

      req.end()
    })
  }
}

interface HopResult {
  readonly status: number
  readonly contentType: string
  readonly body: string
  readonly bytes: number
  readonly location?: string
}

/** `node:dns`'s `lookup` signature, answering with the one address the guard cleared. */
function pinnedLookup(address: string): typeof dnsLookup {
  const family = address.includes(':') ? 6 : 4
  return ((
    _hostname: string,
    options: unknown,
    callback?: (err: NodeJS.ErrnoException | null, ...args: unknown[]) => void,
  ) => {
    const cb = (typeof options === 'function' ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      ...args: unknown[]
    ) => void
    const all =
      typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true
    if (all) {
      cb(null, [{ address, family }] satisfies LookupAddress[])
    } else {
      cb(null, address, family)
    }
  }) as unknown as typeof dnsLookup
}

async function systemResolver(hostname: string): Promise<readonly string[]> {
  const records = await dns.lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

function isFetchableContentType(contentType: string): boolean {
  const mime = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  if (mime === '') return true // No Content-Type at all: read it and let extraction decide.
  return FETCHABLE_CONTENT_TYPES.includes(mime)
}

function charsetOf(contentType: string): BufferEncoding {
  const match = /charset=([^;\s]+)/i.exec(contentType)
  const charset = (match?.[1] ?? 'utf-8').replace(/["']/g, '').toLowerCase()
  if (charset === 'iso-8859-1' || charset === 'latin1' || charset === 'windows-1252') return 'latin1'
  return 'utf8'
}

function transportError(cause: unknown, url: string): PageFetchError {
  if (cause instanceof PageFetchError) return cause
  const code = (cause as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
    return new PageFetchError('timeout', 'Connection timed out.', url)
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new PageFetchError('dns_failure', 'Host did not resolve.', url)
  }
  return new PageFetchError('transport', `Request failed${code ? ` (${code})` : ''}.`, url)
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { classifyAddress, normaliseHost, parseTarget, PUBLIC_ONLY } from './guard'
import { GuardedPageFetcher } from './fetcher'
import { PageFetchError } from './types'
import { loopbackAllowedPolicy } from './testing'

/**
 * The SSRF guard. This suite is deliberately adversarial:
 * the fetcher is a security boundary that four later cards reuse, and a test
 * here that passes for the wrong reason is worse than no test, because it looks
 * like protection.
 *
 * Three families of attack are covered, each end to end where that is possible:
 *
 *  A. **Disguised notations** — the same private address written so it does not
 *     look like one. Asserted on the canonical form *and* the verdict, so the
 *     test fails if Node's URL parser ever stops canonicalising.
 *  B. **DNS answering with a private address** — an ordinary hostname that
 *     resolves inside our network, plus the rebinding case where the answer
 *     changes between the check and the connection.
 *  C. **Redirects** — a real HTTP server, really redirecting, to each of the
 *     ranges that matter.
 */

// ── A. Disguised notations ───────────────────────────────────────────────────

describe('address classification', () => {
  const BLOCKED: [string, string][] = [
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback'],
    ['10.0.0.1', 'private'],
    ['10.255.255.254', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.254', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'metadata'],
    ['169.254.1.1', 'link_local'],
    ['100.64.0.1', 'cgnat'],
    ['0.0.0.0', 'unspecified'],
    ['192.0.0.1', 'reserved'],
    ['192.0.2.5', 'documentation'],
    ['198.51.100.5', 'documentation'],
    ['203.0.113.5', 'documentation'],
    ['192.88.99.1', 'tunnel'],
    ['198.18.0.1', 'benchmark'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['fe80::1', 'link_local'],
    ['fc00::1', 'unique_local'],
    ['fd12:3456::1', 'unique_local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['2001::abcd', 'tunnel'],
    ['100::1', 'discard'],
    // IPv4 hidden inside IPv6.
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:169.254.169.254', 'metadata'],
    ['::ffff:a9fe:a9fe', 'metadata'],
    ['::127.0.0.1', 'loopback'],
    ['64:ff9b::10.0.0.1', 'private'],
    ['2002:a00:1::1', 'private'],
    ['not-an-address', 'malformed'],
  ]

  it.each(BLOCKED)('blocks %s as %s', (address, category) => {
    const verdict = classifyAddress(address)
    expect(verdict.category).toBe(category)
    expect(verdict.blocked).toBe(true)
  })

  const ALLOWED = ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '2606:4700::1111']

  it.each(ALLOWED)('allows public address %s', (address) => {
    expect(classifyAddress(address)).toMatchObject({ category: 'public', blocked: false })
  })

  it('judges a 6to4 address carrying a public IPv4 as a tunnel, not as public', () => {
    // 2002:0808:0808::/48 embeds 8.8.8.8. The inner address is public, but a
    // 6to4 tunnel is still an indirection we have no reason to follow.
    expect(classifyAddress('2002:808:808::1')).toMatchObject({ category: 'tunnel', blocked: true })
  })
})

describe('URL admission', () => {
  it('canonicalises the notations that disguise 127.0.0.1, then blocks them', () => {
    const spellings = [
      'http://127.0.0.1/',
      'http://2130706433/', // decimal
      'http://0177.0.0.1/', // octal first octet
      'http://0x7f.0.0.1/', // hex first octet
      'http://127.1/', // short form
      'http://[::ffff:127.0.0.1]/',
    ]
    for (const spelling of spellings) {
      const target = parseTarget(spelling)
      // The guard never pattern-matches spellings; it works on what the WHATWG
      // parser produced. Assert that canonicalisation actually happened.
      expect(['127.0.0.1', '::ffff:7f00:1']).toContain(normaliseHost(target.url.hostname))
      expect(classifyAddress(target.host).blocked).toBe(true)
    }
  })

  it('blocks a hex/decimal spelling of the cloud metadata address', () => {
    const target = parseTarget('http://2852039166/') // 169.254.169.254
    expect(target.host).toBe('169.254.169.254')
    expect(classifyAddress(target.host).category).toBe('metadata')
  })

  it.each([
    ['file:///etc/passwd', 'blocked_scheme'],
    ['ftp://example.com/x', 'blocked_scheme'],
    ['gopher://example.com/x', 'blocked_scheme'],
    ['data:text/html,hi', 'blocked_scheme'],
    ['http://example.com:8080/', 'blocked_port'],
    ['http://example.com:22/', 'blocked_port'],
    ['http://example.com:6379/', 'blocked_port'],
    ['http://user:pass@example.com/', 'blocked_userinfo'],
    ['http://localhost/', 'blocked_hostname'],
    ['http://api.localhost/', 'blocked_hostname'],
    ['http://db.internal/', 'blocked_hostname'],
    ['http://printer.local/', 'blocked_hostname'],
  ])('refuses %s with reason %s', (url, reason) => {
    expect(() => parseTarget(url)).toThrowError(
      expect.objectContaining({ reason, name: 'PageFetchError' }),
    )
  })

  it.each(['https://example.com/', 'http://example.com:80/', 'https://example.com:443/x?y=1'])(
    'admits %s',
    (url) => {
      expect(parseTarget(url).host).toBe('example.com')
    },
  )

  it('strips the DNS root dot so a trailing-dot bypass is not a bypass', () => {
    // `localhost.` is the same host as `localhost` to a resolver.
    expect(() => parseTarget('http://localhost./')).toThrowError(
      expect.objectContaining({ reason: 'blocked_hostname' }),
    )
  })

  it('marks every SSRF refusal as an SSRF block, and a slow site as not one', () => {
    const blocked = new PageFetchError('blocked_address', 'x')
    const slow = new PageFetchError('timeout', 'x')
    expect(blocked.isSsrfBlock).toBe(true)
    expect(slow.isSsrfBlock).toBe(false)
  })
})

// ── B. DNS answers ───────────────────────────────────────────────────────────

describe('DNS resolution', () => {
  const fetcher = (resolve: (host: string) => Promise<readonly string[]>) =>
    new GuardedPageFetcher({ resolve })

  it('blocks a public-looking hostname that resolves to a private address', async () => {
    await expect(
      fetcher(async () => ['10.0.0.5']).fetch({ url: 'https://intranet.example.com/' }),
    ).rejects.toMatchObject({ reason: 'blocked_address' })
  })

  it('blocks a hostname that resolves to the cloud metadata address', async () => {
    await expect(
      fetcher(async () => ['169.254.169.254']).fetch({ url: 'https://metadata.example.com/' }),
    ).rejects.toMatchObject({ reason: 'blocked_address' })
  })

  it('blocks when ANY answer is private, even though a public one is also offered', async () => {
    // Resolver ordering must not decide whether we are safe.
    await expect(
      fetcher(async () => ['93.184.216.34', '192.168.1.10']).fetch({
        url: 'https://split.example.com/',
      }),
    ).rejects.toMatchObject({ reason: 'blocked_address' })
  })

  it('blocks a host that resolves to nothing rather than falling through', async () => {
    await expect(
      fetcher(async () => []).fetch({ url: 'https://void.example.com/' }),
    ).rejects.toMatchObject({ reason: 'dns_failure' })
  })

  it('resolves the real `localhost` and blocks it — the guard works on real DNS too', async () => {
    // Uses the system resolver, no injection: proves the production wiring.
    await expect(
      new GuardedPageFetcher().fetch({ url: 'http://localhost.dev.sortiva.invalid/' }),
    ).rejects.toMatchObject({ reason: 'dns_failure' })
  })
})

// ── C. Real server: redirects, budgets, pinning ──────────────────────────────

interface Route {
  (req: IncomingMessage, res: ServerResponse): void
}

let server: Server
let origin: string
let testPort: number
const routes = new Map<string, Route>()

beforeAll(async () => {
  server = createServer((req, res) => {
    const route = routes.get((req.url ?? '/').split('?')[0] ?? '/')
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/html' })
      res.end('<html></html>')
      return
    }
    route(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  testPort = port
  origin = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function html(body: string): Route {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(body)
  }
}

function redirectTo(location: string, status = 302): Route {
  return (_req, res) => {
    res.writeHead(status, { location })
    res.end()
  }
}

/** Production policy in every respect except that loopback and the test port are reachable; see testing.ts. */
function testFetcher(options: { budget?: { timeoutMs?: number; maxBytes?: number; maxRedirects?: number } } = {}) {
  return new GuardedPageFetcher({
    policy: loopbackAllowedPolicy(testPort),
    budget: options.budget,
  })
}

describe('the loopback carve-out is the only difference from production', () => {
  it('the production policy blocks the very server these tests use, on both counts', async () => {
    routes.set('/ok', html('<html><title>hi</title></html>'))
    expect(PUBLIC_ONLY.allowedCategories.has('loopback')).toBe(false)
    expect(PUBLIC_ONLY.allowedPorts.has(testPort)).toBe(false)

    // The port rule fires first, so assert it, then lift only the port to prove
    // the address rule is what stands behind it.
    await expect(new GuardedPageFetcher().fetch({ url: `${origin}/ok` })).rejects.toMatchObject({
      reason: 'blocked_port',
    })

    const portOnly = new GuardedPageFetcher({
      policy: {
        name: 'public-only-plus-test-port',
        allowedCategories: PUBLIC_ONLY.allowedCategories,
        allowedPorts: new Set([80, 443, testPort]),
      },
    })
    await expect(portOnly.fetch({ url: `${origin}/ok` })).rejects.toMatchObject({
      reason: 'blocked_address',
    })
  })

  it('and admits it under the test policy, so the tests below are exercising a real fetch', async () => {
    routes.set('/ok', html('<html><title>hi</title></html>'))
    const result = await testFetcher().fetch({ url: `${origin}/ok` })
    expect(result.status).toBe(200)
    expect(result.body).toContain('<title>hi</title>')
  })
})

describe('redirects', () => {
  it('blocks a real redirect to a private address', async () => {
    routes.set('/to-private', redirectTo('http://10.0.0.1/secrets'))
    await expect(testFetcher().fetch({ url: `${origin}/to-private` })).rejects.toMatchObject({
      reason: 'blocked_address',
      url: 'http://10.0.0.1/secrets',
    })
  })

  it('blocks a real redirect to the cloud metadata service', async () => {
    routes.set(
      '/to-metadata',
      redirectTo('http://169.254.169.254/latest/meta-data/iam/security-credentials/'),
    )
    await expect(testFetcher().fetch({ url: `${origin}/to-metadata` })).rejects.toMatchObject({
      reason: 'blocked_address',
    })
  })

  it('blocks a redirect that disguises the private address in decimal', async () => {
    routes.set('/to-decimal', redirectTo('http://2852039166/latest/meta-data/'))
    await expect(testFetcher().fetch({ url: `${origin}/to-decimal` })).rejects.toMatchObject({
      reason: 'blocked_address',
    })
  })

  it('blocks a redirect that downgrades to file:', async () => {
    routes.set('/to-file', redirectTo('file:///etc/passwd'))
    await expect(testFetcher().fetch({ url: `${origin}/to-file` })).rejects.toMatchObject({
      reason: 'blocked_scheme',
    })
  })

  it('blocks a redirect to a non-web port on an otherwise fine host', async () => {
    routes.set('/to-redis', redirectTo('http://example.com:6379/'))
    await expect(testFetcher().fetch({ url: `${origin}/to-redis` })).rejects.toMatchObject({
      reason: 'blocked_port',
    })
  })

  it('blocks a redirect to a hostname that resolves privately', async () => {
    routes.set('/to-name', redirectTo('http://intranet.example.com/'))
    const fetcher = new GuardedPageFetcher({
      policy: loopbackAllowedPolicy(testPort),
      resolve: async () => ['172.16.9.9'],
    })
    await expect(fetcher.fetch({ url: `${origin}/to-name` })).rejects.toMatchObject({
      reason: 'blocked_address',
    })
  })

  it('follows at most 2 redirects (main §3.2)', async () => {
    routes.set('/hop1', redirectTo(`${origin}/hop2`))
    routes.set('/hop2', redirectTo(`${origin}/hop3`))
    routes.set('/hop3', redirectTo(`${origin}/ok`))
    await expect(testFetcher().fetch({ url: `${origin}/hop1` })).rejects.toMatchObject({
      reason: 'too_many_redirects',
    })
  })

  it('follows 2 redirects successfully and reports the chain', async () => {
    routes.set('/two1', redirectTo(`${origin}/two2`))
    routes.set('/two2', redirectTo(`${origin}/ok`))
    routes.set('/ok', html('<html><title>hi</title></html>'))
    const result = await testFetcher().fetch({ url: `${origin}/two1` })
    expect(result.finalUrl).toBe(`${origin}/ok`)
    expect(result.chain).toHaveLength(3)
  })

  it('re-checks a relative redirect against the guard', async () => {
    routes.set('/rel', redirectTo('/ok'))
    routes.set('/ok', html('<html><title>hi</title></html>'))
    const result = await testFetcher().fetch({ url: `${origin}/rel` })
    expect(result.finalUrl).toBe(`${origin}/ok`)
  })
})

describe('DNS rebinding', () => {
  it('connects to the address it checked, not to a second resolution', async () => {
    // The hostname does not exist in DNS at all. If the fetcher connected by
    // name, this request could not succeed; it succeeds only because the
    // connection is pinned to the address the guard cleared.
    let resolutions = 0
    const port = new URL(origin).port
    const fetcher = new GuardedPageFetcher({
      policy: loopbackAllowedPolicy(testPort),
      resolve: async () => {
        resolutions += 1
        return ['127.0.0.1']
      },
    })
    routes.set('/ok', html('<html><title>hi</title></html>'))
    const result = await fetcher.fetch({ url: `http://rebind.invalid:${port}/ok` })
    expect(result.status).toBe(200)
    expect(resolutions).toBe(1)
  })

  it('a resolver that turns hostile on the second answer never gets a second chance', async () => {
    const answers = [['127.0.0.1'], ['169.254.169.254']]
    let call = 0
    const port = new URL(origin).port
    const fetcher = new GuardedPageFetcher({
      policy: loopbackAllowedPolicy(testPort),
      resolve: async () => answers[call++] ?? ['169.254.169.254'],
    })
    routes.set('/ok', html('<html><title>hi</title></html>'))
    const result = await fetcher.fetch({ url: `http://rebind2.invalid:${port}/ok` })
    expect(result.status).toBe(200)
    // One resolution per hop, and this fetch had one hop.
    expect(call).toBe(1)
  })
})

describe('budgets', () => {
  it('rejects a body larger than the cap while it is still streaming', async () => {
    routes.set('/huge', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      // No Content-Length: the cap must hold on the wire, not on the header.
      const chunk = 'x'.repeat(64 * 1024)
      let sent = 0
      const pump = (): void => {
        while (sent < 5_000_000) {
          sent += chunk.length
          if (!res.write(chunk)) {
            res.once('drain', pump)
            return
          }
        }
        res.end()
      }
      pump()
    })
    await expect(
      testFetcher({ budget: { maxBytes: 200_000 } }).fetch({ url: `${origin}/huge` }),
    ).rejects.toMatchObject({ reason: 'response_too_large' })
  })

  it('rejects on a Content-Length over the cap without downloading it', async () => {
    let bodyBytesSent = 0
    routes.set('/declared', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': '9000000' })
      bodyBytesSent += 1
      res.end('x'.repeat(10))
    })
    await expect(
      testFetcher({ budget: { maxBytes: 1_500_000 } }).fetch({ url: `${origin}/declared` }),
    ).rejects.toMatchObject({ reason: 'response_too_large' })
    expect(bodyBytesSent).toBe(1)
  })

  it('accepts a body just under the cap', async () => {
    const body = `<html>${'y'.repeat(1000)}</html>`
    routes.set('/small', html(body))
    const result = await testFetcher({ budget: { maxBytes: 100_000 } }).fetch({
      url: `${origin}/small`,
    })
    expect(result.bytes).toBe(Buffer.byteLength(body))
  })

  it('times out a server that never answers', async () => {
    routes.set('/hang', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.write('<html>')
      // never ends
    })
    const started = Date.now()
    await expect(
      testFetcher({ budget: { timeoutMs: 300 } }).fetch({ url: `${origin}/hang` }),
    ).rejects.toMatchObject({ reason: 'timeout' })
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('applies the timeout across the whole redirect chain, not per hop', async () => {
    routes.set('/slow1', (_req, res) => {
      setTimeout(() => {
        res.writeHead(302, { location: `${origin}/slow2` })
        res.end()
      }, 200)
    })
    routes.set('/slow2', (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html></html>')
      }, 200)
    })
    await expect(
      testFetcher({ budget: { timeoutMs: 250 } }).fetch({ url: `${origin}/slow1` }),
    ).rejects.toMatchObject({ reason: 'timeout' })
  })

  it('refuses a non-page content type instead of downloading it', async () => {
    routes.set('/binary', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' })
      res.end('%PDF-1.4')
    })
    await expect(testFetcher().fetch({ url: `${origin}/binary` })).rejects.toMatchObject({
      reason: 'unsupported_content_type',
    })
  })

  it('surfaces a remote error status as http_status, not as a body', async () => {
    routes.set('/boom', (_req, res) => {
      res.writeHead(500, { 'content-type': 'text/html' })
      res.end('<html>nope</html>')
    })
    await expect(testFetcher().fetch({ url: `${origin}/boom` })).rejects.toMatchObject({
      reason: 'http_status',
    })
  })
})

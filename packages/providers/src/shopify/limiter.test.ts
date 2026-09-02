import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ShopifyAdminClient, ShopifyApiFailure, nextPageInfoFrom } from './admin'
import { BACKGROUND_REQUESTS_PER_SECOND, ShopifyRateLimiter } from './limiter'

/**
 * The pacing every background read of a merchant's store inherits.
 *
 * Two ways of proving it. The burst tests run on a virtual clock, so a
 * twelve-request burst at the shipped rate is measured exactly rather than
 * approximately and costs no wall-clock time. The last test runs the real client
 * against a real server with real timers, because a virtual clock cannot show
 * that the waiting actually happens.
 */

/** A clock the test owns: sleeping moves it, so nothing is timing-dependent. */
function virtualClock() {
  let now = 1_000_000
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms
      // Let other queued work observe the new time before continuing.
      await Promise.resolve()
    },
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('the background rate limit', () => {
  it('never lets a burst exceed one request a second', async () => {
    const clock = virtualClock()
    const limiter = new ShopifyRateLimiter({ now: clock.now, sleep: clock.sleep })
    const departures: number[] = []

    await Promise.all(
      Array.from({ length: 12 }, async () => {
        await limiter.acquire()
        departures.push(clock.now())
      }),
    )

    expect(departures).toHaveLength(12)
    const gaps = departures.slice(1).map((at, i) => at - departures[i]!)
    // The done-when, literally: no two requests in the same second.
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1000 / BACKGROUND_REQUESTS_PER_SECOND)
    // And the burst really was spread rather than collapsed: twelve requests at
    // one a second span eleven seconds.
    expect(departures.at(-1)! - departures[0]!).toBeGreaterThanOrEqual(11_000)
  })

  it('leaves the requests in the order they arrived', async () => {
    const clock = virtualClock()
    const limiter = new ShopifyRateLimiter({ now: clock.now, sleep: clock.sleep })
    const order: number[] = []

    await Promise.all(
      Array.from({ length: 5 }, async (_unused, index) => {
        await limiter.acquire()
        order.push(index)
      }),
    )

    expect(order).toEqual([0, 1, 2, 3, 4])
  })

  it('does not make an idle caller wait', async () => {
    const clock = virtualClock()
    const limiter = new ShopifyRateLimiter({ now: clock.now, sleep: clock.sleep })

    await limiter.acquire()
    const first = clock.now()
    // A minute of silence: the next request should leave immediately rather
    // than inherit a slot booked a minute ago.
    clock.advance(60_000)
    await limiter.acquire()

    expect(clock.now() - first).toBe(60_000)
  })

  it('stops for exactly as long as Shopify asked', async () => {
    const clock = virtualClock()
    const limiter = new ShopifyRateLimiter({ now: clock.now, sleep: clock.sleep })

    await limiter.acquire()
    limiter.pauseFor(7_500)
    const before = clock.now()
    await limiter.acquire()

    expect(clock.now() - before).toBe(7_500)
  })

  it('waits a sensible moment when Shopify rate-limits without saying how long', async () => {
    const clock = virtualClock()
    const limiter = new ShopifyRateLimiter({ now: clock.now, sleep: clock.sleep })

    limiter.pauseFor(undefined)
    const before = clock.now()
    await limiter.acquire()

    expect(clock.now() - before).toBe(1_000)
  })

  it('keeps one store waiting without holding up another', async () => {
    const clock = virtualClock()
    const acme = new ShopifyRateLimiter({ now: clock.now, sleep: clock.sleep })
    const other = new ShopifyRateLimiter({ now: clock.now, sleep: clock.sleep })

    await acme.acquire()
    acme.pauseFor(30_000)
    const before = clock.now()
    await other.acquire()

    expect(clock.now() - before).toBe(0)
  })
})

describe('page cursors', () => {
  it('takes the next page from Shopify own Link header', () => {
    const header =
      '<https://acme.myshopify.com/admin/api/2025-01/products.json?limit=250&page_info=PREV>; rel="previous", ' +
      '<https://acme.myshopify.com/admin/api/2025-01/products.json?limit=250&page_info=NEXT>; rel="next"'
    expect(nextPageInfoFrom(header)).toBe('NEXT')
  })

  it('says there is no next page when the header only points backwards', () => {
    const header =
      '<https://acme.myshopify.com/admin/api/2025-01/products.json?page_info=PREV>; rel="previous"'
    expect(nextPageInfoFrom(header)).toBeUndefined()
    expect(nextPageInfoFrom(null)).toBeUndefined()
  })
})

describe('the client against a server that answers slowly enough to measure', () => {
  let server: Server
  let base: string
  let requests: number[] = []
  let rateLimitNext = false

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requests.push(Date.now())
      if (rateLimitNext) {
        rateLimitNext = false
        res.writeHead(429, { 'retry-after': '0.2', 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      const page = new URL(req.url ?? '/', base).searchParams.get('page_info')
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (!page) {
        headers['link'] = `<${base}/admin/api/2025-01/products.json?page_info=P2>; rel="next"`
      }
      res.writeHead(200, headers)
      res.end(JSON.stringify({ products: [{ id: page ? 2 : 1 }] }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no test server address')
    base = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('paces real requests and carries the cursor from one page to the next', async () => {
    requests = []
    // A tenth of the shipped rate's interval, so the test costs 200ms rather
    // than two seconds. The policy under test is the same; only the number is
    // smaller, and the burst test above pins the shipped number.
    const client = new ShopifyAdminClient({
      storeBaseUrl: () => base,
      limiter: { requestsPerSecond: 10 },
    })
    const auth = { shop: 'acme', accessToken: 'shpat_x' }

    const first = await client.getPage<{ products: { id: number }[] }>(auth, 'products.json')
    expect(first.nextPageInfo).toBe('P2')
    const second = await client.getPage<{ products: { id: number }[] }>(
      auth,
      `products.json?page_info=${first.nextPageInfo}`,
    )
    expect(second.body.products[0]?.id).toBe(2)
    expect(second.nextPageInfo).toBeUndefined()

    expect(requests).toHaveLength(2)
    expect(requests[1]! - requests[0]!).toBeGreaterThanOrEqual(90)
  })

  it('holds the whole store back after a 429, not just the call that got one', async () => {
    requests = []
    const client = new ShopifyAdminClient({
      storeBaseUrl: () => base,
      limiter: { requestsPerSecond: 1000 },
    })
    const auth = { shop: 'acme', accessToken: 'shpat_x' }

    rateLimitNext = true
    await expect(client.get(auth, 'products.json')).rejects.toBeInstanceOf(ShopifyApiFailure)
    // The rate would otherwise allow the next request within a millisecond;
    // Shopify asked for 200ms and gets them.
    await client.get(auth, 'products.json')

    expect(requests[1]! - requests[0]!).toBeGreaterThanOrEqual(190)
  })
})

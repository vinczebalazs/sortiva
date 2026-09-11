import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { staticShopifyAuth } from '@sortiva/core'
import { ShopifyAdminClient } from './admin'
import { ShopifyGraphqlClient } from './graphql'
import { RESERVED_BUCKET_SHARE, ShopifyRateLimiter, ShopifyRateLimiters, type ThrottleStatus } from './limiter'

/**
 * The pacing every background read of a merchant's store inherits.
 *
 * Shopify gives each store a bucket of cost points that refills at a fixed rate
 * and reports, with every answer, how full it is. We pace on those numbers, and
 * we stop short of the half of the bucket we leave for the merchant's own admin
 * and for any other app they use.
 *
 * Two ways of proving it. The burst tests run on a virtual clock against a
 * bucket that refills the way Shopify's does, so waits are measured exactly and
 * cost no wall-clock time. The last tests run the real client against a real
 * server with real timers, because a virtual clock cannot show that the waiting
 * actually happens.
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

/**
 * Shopify's accounting, as far as the limiter can tell: the bucket refills at
 * `restoreRate` a second, a request is paid for out of it, and what is left is
 * what the answer reports.
 */
function storeBucket(
  clock: { now: () => number },
  shape: { maximumAvailable: number; restoreRate: number },
) {
  let available = shape.maximumAvailable
  let at = clock.now()
  return {
    spend(cost: number): ThrottleStatus {
      const now = clock.now()
      available = Math.min(
        shape.maximumAvailable,
        available + ((now - at) / 1000) * shape.restoreRate,
      )
      at = now
      available -= cost
      return { ...shape, currentlyAvailable: available }
    },
  }
}

describe('the background rate limit', () => {
  it('never lets a burst eat into the half of the bucket left for the merchant', async () => {
    const clock = virtualClock()
    const limiter = new ShopifyRateLimiter({ now: clock.now, sleep: clock.sleep })
    const bucket = storeBucket(clock, { maximumAvailable: 2_000, restoreRate: 100 })
    const leftAfterEach: number[] = []
    const departures: number[] = []

    await Promise.all(
      Array.from({ length: 12 }, async () =>
        limiter.run(100, async () => {
          departures.push(clock.now())
          const status = bucket.spend(100)
          leftAfterEach.push(status.currentlyAvailable)
          limiter.observe(status)
        }),
      ),
    )

    expect(departures).toHaveLength(12)
    // The done-when, literally: the reserve is never spent into.
    expect(Math.min(...leftAfterEach)).toBeGreaterThanOrEqual(2_000 * RESERVED_BUCKET_SHARE)
    // And the burst really was spread rather than collapsed: the last requests
    // waited for the bucket to refill instead of going straight out.
    expect(departures.at(-1)! - departures[0]!).toBeGreaterThanOrEqual(1_000)
  })

  it('leaves the requests in the order they arrived', async () => {
    const clock = virtualClock()
    const limiter = new ShopifyRateLimiter({ now: clock.now, sleep: clock.sleep })
    const order: number[] = []

    await Promise.all(
      Array.from({ length: 5 }, async (_unused, index) =>
        limiter.run(100, async () => {
          order.push(index)
        }),
      ),
    )

    expect(order).toEqual([0, 1, 2, 3, 4])
  })

  it('does not make an idle caller wait', async () => {
    const clock = virtualClock()
    const limiter = new ShopifyRateLimiter({ now: clock.now, sleep: clock.sleep })

    // The bucket was empty when we last looked — but that was a minute ago, and
    // it has been refilling ever since.
    limiter.observe({ maximumAvailable: 2_000, currentlyAvailable: 0, restoreRate: 100 })
    clock.advance(60_000)
    const before = clock.now()
    await limiter.run(100, async () => {})

    expect(clock.now() - before).toBe(0)
  })

  it('waits for a full bucket when one request costs more than it may ever spend', async () => {
    const clock = virtualClock()
    const limiter = new ShopifyRateLimiter({ now: clock.now, sleep: clock.sleep })

    // Half of 2,000 is reserved, so a 1,500-point request could never be
    // afforded. It waits for the bucket to fill and goes, rather than never.
    limiter.observe({ maximumAvailable: 2_000, currentlyAvailable: 0, restoreRate: 100 })
    const before = clock.now()
    await limiter.run(1_500, async () => {})

    expect(clock.now() - before).toBe(20_000)
  })

  it('stops for exactly as long as Shopify asked', async () => {
    const clock = virtualClock()
    const limiter = new ShopifyRateLimiter({ now: clock.now, sleep: clock.sleep })

    limiter.pauseFor(7_500)
    const before = clock.now()
    await limiter.run(100, async () => {})

    expect(clock.now() - before).toBe(7_500)
  })

  it('waits a sensible moment when Shopify rate-limits without saying how long', async () => {
    const clock = virtualClock()
    const limiter = new ShopifyRateLimiter({ now: clock.now, sleep: clock.sleep })

    limiter.pauseFor(undefined)
    const before = clock.now()
    await limiter.run(100, async () => {})

    expect(clock.now() - before).toBe(1_000)
  })

  it('keeps one store waiting without holding up another', async () => {
    const clock = virtualClock()
    const limiters = new ShopifyRateLimiters({ now: clock.now, sleep: clock.sleep })

    limiters.for('acme').pauseFor(30_000)
    const before = clock.now()
    await limiters.for('other-store').run(100, async () => {})

    expect(clock.now() - before).toBe(0)
  })

  it('gives everything that talks to one store the same pacing', async () => {
    // The catalogue sync, the content inventory and a publish all reach the
    // same shop on the same night. One limiter per store is what stops each of
    // them believing it is the only caller.
    const limiters = new ShopifyRateLimiters()

    expect(limiters.for('acme')).toBe(limiters.for('acme'))
    expect(limiters.for('acme')).not.toBe(limiters.for('other-store'))
  })
})

describe('the client against a server that answers slowly enough to measure', () => {
  let server: Server
  let base: string
  let requests: number[] = []
  let throttleNext = false
  /** What the fake Shopify reports its bucket at, which is what the next wait is computed from. */
  let bucket = { maximumAvailable: 1_000, currentlyAvailable: 600, restoreRate: 1_000 }

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        requests.push(Date.now())
        if (throttleNext) {
          throttleNext = false
          res.writeHead(429, { 'retry-after': '0.2', 'content-type': 'application/json' })
          res.end('{}')
          return
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          query: string
          variables?: { after?: string | null }
        }
        const after = body.variables?.after ?? null
        const payload = body.query.includes('SortivaShop')
          ? { shop: { myshopifyDomain: 'acme.myshopify.com' } }
          : {
              products: {
                pageInfo: { hasNextPage: after === null, endCursor: 'P2' },
                nodes: [
                  {
                    legacyResourceId: after === null ? '1' : '2',
                    title: 'A product',
                    variants: { nodes: [] },
                    metafields: { nodes: [] },
                  },
                ],
              },
            }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            data: payload,
            extensions: { cost: { requestedQueryCost: 250, throttleStatus: bucket } },
          }),
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no test server address')
    base = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const auth = staticShopifyAuth('acme', 'shpat_x')

  it('paces real requests and carries the cursor from one page to the next', async () => {
    requests = []
    // A bucket that refills a thousand points a second, reported at 600 of
    // 1,000: a 250-point page needs 750 before it may go, so the second page
    // waits 150ms. The policy is the shipped one; only the numbers are small
    // enough for a test, and the burst test above pins the shipped share.
    bucket = { maximumAvailable: 1_000, currentlyAvailable: 600, restoreRate: 1_000 }
    const client = new ShopifyAdminClient({ storeBaseUrl: () => base })

    const startedAt = Date.now()
    const first = await client.listProducts(auth)
    expect(first.items[0]?.id).toBe('1')
    expect(first.next).toBe('P2')
    const second = await client.listProducts(auth, { after: first.next! })
    expect(second.items[0]?.id).toBe('2')
    expect(second.next).toBeUndefined()

    expect(requests).toHaveLength(2)

    /**
     * Timed from here rather than from when the two requests **arrived** at the
     * server, and the difference is not pedantry.
     *
     * The limiter controls when a request is sent. The server's clock records
     * when one turns up. When the machine is busy — this suite runs hundreds of
     * files at once — a request can sit between those two moments, and if the
     * first request waits longer than the second the gap *at the server* comes
     * out shorter than the gap the limiter actually left. That is a test
     * failing on scheduling noise, and it did.
     *
     * Measured from the caller's side, delay can only ever push this number up.
     * A failure here means the limiter really did not wait.
     */
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(120)
  })

  it('holds the whole store back after a 429, not just the call that got one', async () => {
    requests = []
    // A bucket with room to spare, so anything measured here is the 429's doing
    // and not the pacing's.
    bucket = { maximumAvailable: 1_000, currentlyAvailable: 1_000, restoreRate: 1_000 }
    // One transport, two clients — which is how the real process reaches a
    // store: the reader and the publisher share a store's pacing.
    const transport = new ShopifyGraphqlClient({ storeBaseUrl: () => base })
    const reader = new ShopifyAdminClient({ graphql: transport })
    const other = new ShopifyAdminClient({ graphql: transport })

    throttleNext = true
    const startedAt = Date.now()
    const [, otherFinishedAt] = await Promise.all([
      reader.getShop(auth),
      other.getShop(auth).then(() => Date.now()),
    ])

    // Three arrivals: the throttled one, its retry, and the second client's.
    expect(requests).toHaveLength(3)
    // Shopify asked for 200ms and got them — from the client that was never
    // throttled as well as from the one that was.
    expect(otherFinishedAt - startedAt).toBeGreaterThanOrEqual(190)
  })
})

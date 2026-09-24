import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { detectPlatform } from '@sortiva/core'
import { GuardedPageFetcher } from './fetcher'
import { loopbackAllowedPolicy } from './testing'

/**
 * A heavy storefront is still a storefront.
 *
 * Detection used to ask the fetcher for at most 600 KB, and the fetcher refuses
 * a response over its budget rather than truncating it. So a shop whose
 * homepage was bigger was not read partially — it was not read at all, and the
 * merchant's onboarding stopped at its first step. Both real shops that
 * reproduced it are ordinary retailers; nothing about them is unusual except
 * the weight of their markup.
 *
 * Against a real server and the real fetcher, because the defect is exactly the
 * join between them: detection's number, and the fetcher's decision to refuse
 * rather than trim. A stubbed fetcher ignores the budget and would have passed
 * this test throughout the period the product could not onboard a large store.
 */

let server: Server
let base: string
let port: number

/** Comfortably over the old 600 KB cap and under the documented 1.5 MB one. */
const PADDING = 'x'.repeat(900_000)

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.startsWith('/huge')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'X-ShopId': '12345' })
      // The tell is near the top, as it is on a real storefront, and the weight
      // is below it — so a reader that truncated would still have detected.
      // Refusing the whole response is what breaks it.
      res.end(
        `<html><head><script>window.Shopify = {};</script></head><body>` +
          `<a href="https://heavy-store.myshopify.com">store</a><!--${PADDING}--></body></html>`,
      )
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('nope')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
  base = `127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function fetcher(): GuardedPageFetcher {
  return new GuardedPageFetcher({
    policy: loopbackAllowedPolicy(port),
    resolve: async () => ['127.0.0.1'],
  })
}

describe('detecting a store whose homepage is large', () => {
  it('reads a homepage well over the old 600 KB cap', async () => {
    // `detectPlatform` builds `https://<domain>/`, and the test server speaks
    // plain HTTP, so the page is fetched directly with detection's own budget
    // rather than through the domain form.
    const page = await fetcher().fetch({
      url: `http://${base}/huge`,
      budget: { timeoutMs: 8_000, maxBytes: 1_500_000, maxRedirects: 3 },
    })

    expect(page.status).toBe(200)
    expect(page.bytes).toBeGreaterThan(600_000)
  })

  it('refuses the same page under the budget detection used to pass', async () => {
    // The old behaviour, stated rather than remembered: this is what the
    // merchant met, and it is a refusal and not a short read.
    await expect(
      fetcher().fetch({
        url: `http://${base}/huge`,
        budget: { timeoutMs: 8_000, maxBytes: 600_000, maxRedirects: 3 },
      }),
    ).rejects.toThrow(/too large|exceed/i)
  })

  it('finds the store, its signals and its handle in the heavy page', async () => {
    const detection = await detectPlatform(
      {
        fetcher: {
          fetch: (request) =>
            fetcher().fetch({
              ...request,
              // Detection asks for `https://<domain>/`; the local server is
              // plain HTTP on a loopback port. Everything else — the budget it
              // chose, the guard, the size decision — is the real thing.
              url: `http://${base}/huge`,
            }),
        },
      },
      'heavy-store.example',
    )

    expect(detection.platform).toBe('shopify')
    expect(detection.signals).toContain('shop_id_header')
    expect(detection.shopHandle).toBe('heavy-store')
  })
})

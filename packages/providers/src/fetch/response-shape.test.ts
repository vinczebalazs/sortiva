import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GuardedPageFetcher } from './fetcher'
import { PageFetchError } from './types'
import { loopbackAllowedPolicy } from './testing'

/**
 * Two things the fetcher gives back beyond the page body, both needed to tell a
 * Shopify store from anything else: the response headers, which is where the
 * strongest evidence lives, and the ability for one caller to read a JSON feed
 * without every other caller starting to swallow JSON too.
 *
 * Against a real server rather than a stub — a header the fetcher never
 * forwards is exactly the failure a stub would hide.
 */

let server: Server
let base: string
let port: number

function fetcher(): GuardedPageFetcher {
  return new GuardedPageFetcher({
    policy: loopbackAllowedPolicy(port),
    resolve: async () => ['127.0.0.1'],
  })
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.startsWith('/storefront')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'X-ShopId': '12345',
        'Powered-By': 'Shopify',
      })
      res.end('<html><body>store</body></html>')
      return
    }
    if (req.url?.startsWith('/products.json')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"products":[]}')
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('no')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('no port')
  port = address.port
  base = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('response headers', () => {
  it('hands back the final hop’s headers, lower-cased', async () => {
    const result = await fetcher().fetch({ url: `${base}/storefront` })

    expect(result.headers['x-shopid']).toBe('12345')
    expect(result.headers['powered-by']).toBe('Shopify')
  })
})

describe('content types a caller may read', () => {
  it('refuses JSON by default, so no existing caller starts swallowing feeds', async () => {
    await expect(fetcher().fetch({ url: `${base}/products.json` })).rejects.toMatchObject({
      reason: 'unsupported_content_type',
    })
  })

  it('reads JSON for the one caller that asks for it', async () => {
    const result = await fetcher().fetch({
      url: `${base}/products.json`,
      contentTypes: ['application/json'],
    })

    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toEqual({ products: [] })
  })

  it('widening what may be read does not widen what may be reached', async () => {
    // The guard is not a parameter: a private address stays refused however the
    // caller describes what it is willing to read.
    const guarded = new GuardedPageFetcher({ resolve: async () => ['127.0.0.1'] })
    await expect(
      guarded.fetch({ url: `${base}/products.json`, contentTypes: ['application/json'] }),
    ).rejects.toBeInstanceOf(PageFetchError)
  })
})

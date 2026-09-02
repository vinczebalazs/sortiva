import { createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ShopifyAdminClient, ShopifyApiFailure, ShopifyTokenInvalid, retryAfterFrom } from './admin'
import { MockShopifyOAuthClient } from './mock'
import { ShopifyOAuthClient, ShopifyOAuthFailure, verifyWebhookHmac } from './oauth'

/**
 * The install handshake, driven against a real HTTP server standing in for
 * Shopify. A stub that always says yes would prove nothing about the two things
 * that actually matter here: that we never ask for write permission, and that a
 * forged callback is refused.
 */

const API_KEY = 'test-api-key'
const API_SECRET = 'test-api-secret'

let server: Server
let base: string
/** What the fake Shopify answers the code exchange with. */
let exchangeResponse: { status: number; body: unknown } = {
  status: 200,
  body: { access_token: 'shpat_real', scope: 'read_products,read_orders,read_content,read_locales' },
}
let lastExchangeBody: Record<string, unknown> | undefined

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.endsWith('/admin/oauth/access_token')) {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        lastExchangeBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        res.writeHead(exchangeResponse.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(exchangeResponse.body))
      })
      return
    }
    if (req.url?.includes('/shop.json')) {
      if (req.headers['x-shopify-access-token'] !== 'shpat_real') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end('{"errors":"Invalid API key or access token"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          shop: {
            id: 7,
            name: 'Acme Candles',
            myshopify_domain: 'acme.myshopify.com',
            domain: 'acme.example',
            country_code: 'GB',
            currency: 'GBP',
            iana_timezone: 'Europe/London',
          },
        }),
      )
      return
    }
    if (req.url?.includes('/throttled.json')) {
      res.writeHead(429, { 'retry-after': '2.5', 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('no port')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function client(): ShopifyOAuthClient {
  return new ShopifyOAuthClient({
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    storeBaseUrl: () => base,
  })
}

function admin(): ShopifyAdminClient {
  return new ShopifyAdminClient({ storeBaseUrl: () => base })
}

describe('the consent screen we send merchants to', () => {
  it('asks for the four read permissions and nothing that can write', () => {
    const url = new URL(
      client().authorizeUrl({
        shop: 'acme',
        redirectUri: 'https://app.example/api/shopify/oauth/callback',
        state: 'signed-state',
      }),
    )

    expect(url.searchParams.get('scope')).toBe(
      'read_products,read_orders,read_content,read_locales',
    )
    expect(url.toString()).not.toContain('write_')
    expect(url.searchParams.get('client_id')).toBe(API_KEY)
    expect(url.searchParams.get('state')).toBe('signed-state')
  })

  it('does not ask for a token tied to the person who happens to be signed in', () => {
    // A per-user token dies with their session, and the work runs on a schedule.
    expect(client().authorizeUrl({ shop: 'acme', redirectUri: 'https://a/b', state: 's' })).not.toContain(
      'grant_options',
    )
  })

  it('refuses a store name that could reshape the URL', () => {
    expect(() =>
      client().authorizeUrl({ shop: 'acme.myshopify.com/../evil', redirectUri: 'https://a/b', state: 's' }),
    ).toThrow(ShopifyOAuthFailure)
  })
})

describe('proving the redirect really came from Shopify', () => {
  function sign(query: Record<string, string>): Record<string, string> {
    const message = Object.keys(query)
      .filter((k) => k !== 'hmac')
      .sort()
      .map((k) => `${k}=${query[k]}`)
      .join('&')
    return { ...query, hmac: createHmac('sha256', API_SECRET).update(message, 'utf8').digest('hex') }
  }

  it('accepts a genuinely signed callback', () => {
    const query = sign({ code: 'abc', shop: 'acme.myshopify.com', state: 'xyz', timestamp: '1' })
    expect(client().verifyCallbackSignature({ query })).toBe(true)
  })

  it('refuses one with no signature at all', () => {
    expect(
      client().verifyCallbackSignature({ query: { code: 'abc', shop: 'acme.myshopify.com' } }),
    ).toBe(false)
  })

  it('refuses one where a parameter was changed after signing', () => {
    const query = sign({ code: 'abc', shop: 'acme.myshopify.com', state: 'xyz' })
    expect(client().verifyCallbackSignature({ query: { ...query, shop: 'attacker.myshopify.com' } })).toBe(
      false,
    )
  })

  it('refuses one signed with somebody else’s secret', () => {
    const message = 'code=abc&shop=acme.myshopify.com'
    const query = {
      code: 'abc',
      shop: 'acme.myshopify.com',
      hmac: createHmac('sha256', 'not-our-secret').update(message, 'utf8').digest('hex'),
    }
    expect(client().verifyCallbackSignature({ query })).toBe(false)
  })
})

describe('webhook signatures', () => {
  it('verifies against the exact bytes that were sent, not a re-serialisation', () => {
    const raw = '{"shop_domain":"acme.myshopify.com",  "id": 1}'
    const header = createHmac('sha256', API_SECRET).update(raw).digest('base64')

    expect(verifyWebhookHmac(raw, header, API_SECRET)).toBe(true)
    // The same payload, re-serialised, no longer matches — which is the point.
    expect(verifyWebhookHmac(JSON.stringify(JSON.parse(raw)), header, API_SECRET)).toBe(false)
  })

  it('refuses an empty or malformed signature', () => {
    expect(verifyWebhookHmac('{}', '', API_SECRET)).toBe(false)
    expect(verifyWebhookHmac('{}', 'not-base64!!', API_SECRET)).toBe(false)
  })
})

describe('trading the code for a token', () => {
  it('sends the app credentials and returns what Shopify granted', async () => {
    exchangeResponse = {
      status: 200,
      body: { access_token: 'shpat_real', scope: 'read_products,read_orders' },
    }

    const grant = await client().exchangeCode({ shop: 'acme', code: 'one-time-code' })

    expect(grant.accessToken).toBe('shpat_real')
    expect(grant.grantedScopes).toEqual(['read_products', 'read_orders'])
    expect(lastExchangeBody).toMatchObject({ client_id: API_KEY, client_secret: API_SECRET, code: 'one-time-code' })
  })

  it('treats a rejected code as final and a Shopify fault as worth retrying', async () => {
    exchangeResponse = { status: 400, body: { error: 'invalid_request' } }
    await expect(client().exchangeCode({ shop: 'acme', code: 'used' })).rejects.toMatchObject({
      retryable: false,
    })

    exchangeResponse = { status: 503, body: {} }
    await expect(client().exchangeCode({ shop: 'acme', code: 'x' })).rejects.toMatchObject({
      retryable: true,
    })
  })
})

describe('reading the store back', () => {
  it('confirms a fresh token works by reading the shop record', async () => {
    const profile = await admin().getShop({ shop: 'acme', accessToken: 'shpat_real' })

    expect(profile.myshopifyDomain).toBe('acme.myshopify.com')
    expect(profile.ianaTimezone).toBe('Europe/London')
  })

  it('turns a rejected token into its own kind of failure, not a retry', async () => {
    const error = await admin()
      .getShop({ shop: 'acme', accessToken: 'stale' })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ShopifyTokenInvalid)
    expect((error as ShopifyTokenInvalid).retryable).toBe(false)
  })

  it('honours Retry-After exactly rather than guessing a backoff', async () => {
    const error = await admin()
      .get({ shop: 'acme', accessToken: 'shpat_real' }, 'throttled.json')
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ShopifyApiFailure)
    expect((error as ShopifyApiFailure).retryAfterMs).toBe(2500)
    expect(retryAfterFrom('1')).toBe(1000)
    expect(retryAfterFrom(null)).toBeUndefined()
  })
})

describe('the in-memory Shopify used by tests and local development', () => {
  it('signs callbacks the way Shopify does, so a missing check fails here first', () => {
    const mock = new MockShopifyOAuthClient()
    const signed = mock.signCallback({ shop: 'acme.myshopify.com', code: 'c', state: 's' })

    expect(mock.verifyCallbackSignature({ query: signed })).toBe(true)
    expect(mock.verifyCallbackSignature({ query: { ...signed, code: 'tampered' } })).toBe(false)
  })
})

describe('handing the store grant back', () => {
  function revoking(respond: () => Response): {
    client: ShopifyOAuthClient
    calls: { url: string; method: string; token: string | null }[]
  } {
    const calls: { url: string; method: string; token: string | null }[] = []
    const client = new ShopifyOAuthClient({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      storeBaseUrl: (shop) => `https://${shop}.myshopify.test`,
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers)
        calls.push({
          url: String(input),
          method: init?.method ?? 'GET',
          token: headers.get('x-shopify-access-token'),
        })
        return respond()
      },
    })
    return { client, calls }
  }

  it('deletes the current permissions, which is what an uninstall does', async () => {
    const { client, calls } = revoking(() => new Response('{}', { status: 200 }))
    await client.revokeAccess({ shop: 'acme', accessToken: 'shpat_real' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('DELETE')
    expect(calls[0]!.url).toContain('/api_permissions/current.json')
    expect(calls[0]!.token).toBe('shpat_real')
  })

  it('treats a token Shopify has already forgotten as done', async () => {
    // A 401 means the grant is gone, which is the outcome asked for. Anything
    // else would make a retried deletion job fail on the success of its first
    // attempt.
    const { client } = revoking(() => new Response('{}', { status: 401 }))
    await expect(
      client.revokeAccess({ shop: 'acme', accessToken: 'stale' }),
    ).resolves.toBeUndefined()
  })

  it('asks to be retried when Shopify is broken, and not when it refuses', async () => {
    const broken = revoking(() => new Response('{}', { status: 503 }))
    await expect(
      broken.client.revokeAccess({ shop: 'acme', accessToken: 't' }),
    ).rejects.toMatchObject({ retryable: true })

    const refused = revoking(() => new Response('{}', { status: 422 }))
    await expect(
      refused.client.revokeAccess({ shop: 'acme', accessToken: 't' }),
    ).rejects.toMatchObject({ retryable: false })
  })
})

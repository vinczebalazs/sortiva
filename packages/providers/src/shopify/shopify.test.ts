import { createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ShopifyGrantGone, staticShopifyAuth, type ShopifyAuth } from '@sortiva/core'
import { ShopifyAdminClient } from './admin'
import {
  ShopifyAccessDenied,
  ShopifyApiFailure,
  ShopifyGraphqlClient,
  ShopifyQueryRejected,
  ShopifyStoreUnavailable,
  ShopifyTokenInvalid,
  gidOf,
  legacyIdOf,
  retryAfterFrom,
  tokenFingerprint,
} from './graphql'
import { MockShopifyOAuthClient } from './mock'
import { ShopifyOAuthClient, ShopifyOAuthFailure, verifyWebhookHmac } from './oauth'

/**
 * The install handshake and the single door every later request goes through,
 * driven against a real HTTP server standing in for Shopify. A stub that always
 * says yes would prove nothing about the things that actually matter here: that
 * we never ask for write permission, that a forged callback is refused, and
 * that each way Shopify can refuse us gets the answer it deserves — because
 * sending a merchant to reconnect when the token was never the problem is a
 * lie they cannot act on.
 */

const CLIENT_ID = 'test-client-id'
const CLIENT_SECRET = 'test-client-secret'

let server: Server
let base: string
/** What the fake Shopify answers the code exchange with. */
let exchangeResponse: { status: number; body: unknown } = {
  status: 200,
  body: { access_token: 'shpat_real', scope: 'read_products,read_orders,read_content' },
}
let lastExchangeBody: Record<string, unknown> | undefined
/** Makes the next store read answer the way Shopify does when it is rate-limiting us. */
let throttleNext = false

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify(body))
      }

      if (req.url?.endsWith('/admin/oauth/access_token')) {
        lastExchangeBody = JSON.parse(raw) as Record<string, unknown>
        json(exchangeResponse.status, exchangeResponse.body)
        return
      }
      if (req.url?.endsWith('/graphql.json')) {
        if (throttleNext) {
          throttleNext = false
          json(429, {}, { 'retry-after': '2.5' })
          return
        }
        if (req.headers['x-shopify-access-token'] !== 'shpat_real') {
          json(401, { errors: 'Invalid API key or access token' })
          return
        }
        json(200, {
          data: {
            shop: {
              id: 'gid://shopify/Shop/7',
              name: 'Acme Candles',
              myshopifyDomain: 'acme.myshopify.com',
              ianaTimezone: 'Europe/London',
              currencyCode: 'GBP',
              shopAddress: { countryCodeV2: 'GB' },
              primaryDomain: { host: 'acme.example', localization: { defaultLocale: 'en-GB' } },
            },
          },
        })
        return
      }
      json(500, {})
    })
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
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    storeBaseUrl: () => base,
  })
}

function admin(options: { maxThrottleRetries?: number } = {}): ShopifyAdminClient {
  return new ShopifyAdminClient({
    storeBaseUrl: () => base,
    limiter: { sleep: async () => {} },
    ...options,
  })
}

describe('the consent screen we send merchants to', () => {
  it('asks for the read permissions and nothing that can write', () => {
    const url = new URL(
      client().authorizeUrl({
        shop: 'acme',
        redirectUri: 'https://app.example/api/shopify/oauth/callback',
        state: 'signed-state',
      }),
    )

    expect(url.searchParams.get('scope')).toBe('read_products,read_orders,read_content')
    expect(url.toString()).not.toContain('write_')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
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
    return { ...query, hmac: createHmac('sha256', CLIENT_SECRET).update(message, 'utf8').digest('hex') }
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
    const header = createHmac('sha256', CLIENT_SECRET).update(raw).digest('base64')

    expect(verifyWebhookHmac(raw, header, CLIENT_SECRET)).toBe(true)
    // The same payload, re-serialised, no longer matches — which is the point.
    expect(verifyWebhookHmac(JSON.stringify(JSON.parse(raw)), header, CLIENT_SECRET)).toBe(false)
  })

  it('refuses an empty or malformed signature', () => {
    expect(verifyWebhookHmac('{}', '', CLIENT_SECRET)).toBe(false)
    expect(verifyWebhookHmac('{}', 'not-base64!!', CLIENT_SECRET)).toBe(false)
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
    expect(lastExchangeBody).toMatchObject({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: 'one-time-code',
    })
  })

  it('asks for the kind of token that expires, and keeps what renews it', async () => {
    // Shopify requires apps like ours to hold hour-long tokens. Without asking
    // for one it hands back a permanent token the API then refuses.
    exchangeResponse = {
      status: 200,
      body: {
        access_token: 'shpat_real',
        scope: 'read_products',
        expires_in: 3600,
        refresh_token: 'shprt_one',
        refresh_token_expires_in: 7_776_000,
      },
    }

    const grant = await client().exchangeCode({ shop: 'acme', code: 'one-time-code' })

    expect(lastExchangeBody).toMatchObject({ expiring: '1' })
    expect(grant.refreshToken).toBe('shprt_one')
    expect(grant.expiresAt?.getTime()).toBeGreaterThan(Date.now())
    expect(grant.refreshTokenExpiresAt?.getTime()).toBeGreaterThan(grant.expiresAt!.getTime())
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

describe('buying the next token with the refresh token', () => {
  it('hands back a fresh pair, because Shopify retires the old refresh token on first use', async () => {
    exchangeResponse = {
      status: 200,
      body: {
        access_token: 'shpat_second',
        scope: 'read_products',
        expires_in: 3600,
        refresh_token: 'shprt_two',
        refresh_token_expires_in: 7_776_000,
      },
    }

    const grant = await client().refreshAccess({ shop: 'acme', refreshToken: 'shprt_one' })

    expect(lastExchangeBody).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'shprt_one',
    })
    expect(grant.accessToken).toBe('shpat_second')
    expect(grant.refreshToken).toBe('shprt_two')
  })

  it('says the grant is gone when Shopify refuses the refresh token', async () => {
    // A refused refresh token never becomes valid again — the merchant
    // uninstalled us, or it sat unused for ninety days. Only they can fix it,
    // so it must not look like a failure worth retrying.
    exchangeResponse = { status: 400, body: { error: 'invalid_grant' } }

    const error = await client()
      .refreshAccess({ shop: 'acme', refreshToken: 'retired' })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ShopifyGrantGone)
    expect(error).toMatchObject({ retryable: false, errorClass: 'shopify_token_invalid' })
  })

  it('asks to be tried again when Shopify itself was broken', async () => {
    exchangeResponse = { status: 503, body: {} }

    const error = await client()
      .refreshAccess({ shop: 'acme', refreshToken: 'good' })
      .catch((e: unknown) => e)

    expect(error).not.toBeInstanceOf(ShopifyGrantGone)
    expect(error).toMatchObject({ retryable: true })
  })
})

describe('reading the store back', () => {
  it('confirms a fresh token works by reading the shop record', async () => {
    const profile = await admin().getShop(staticShopifyAuth('acme', 'shpat_real'))

    expect(profile.myshopifyDomain).toBe('acme.myshopify.com')
    expect(profile.ianaTimezone).toBe('Europe/London')
    // The host shoppers visit, which is the only spelling Search Console will
    // ever report the store's traffic under.
    expect(profile.primaryDomain).toBe('acme.example')
    expect(profile.primaryLocale).toBe('en-GB')
  })

  it('turns a rejected token into its own kind of failure, not a retry', async () => {
    const error = await admin()
      .getShop(staticShopifyAuth('acme', 'stale'))
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ShopifyTokenInvalid)
    expect((error as ShopifyTokenInvalid).retryable).toBe(false)
  })

  it('honours Retry-After exactly rather than guessing a backoff', async () => {
    throttleNext = true
    const error = await admin({ maxThrottleRetries: 0 })
      .getShop(staticShopifyAuth('acme', 'shpat_real'))
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ShopifyApiFailure)
    expect((error as ShopifyApiFailure).retryAfterMs).toBe(2500)
    expect(retryAfterFrom('1')).toBe(1000)
    expect(retryAfterFrom(null)).toBeUndefined()
  })

  /**
   * We answer Shopify's customer-data requests by saying we hold nothing about
   * any shopper. Dropping those fields after reading them is one padlock; never
   * asking for them is the other, and this is the only place the second one can
   * be checked — an order query is written here and nowhere else.
   *
   * Asserted against the query Shopify is actually sent, so adding a field is
   * what fails, rather than someone having to remember this promise exists.
   */
  it('asks an order for nothing that could name the person who placed it', async () => {
    const asked: string[] = []
    const client = new ShopifyAdminClient({
      storeBaseUrl: () => 'https://acme.test',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        asked.push(JSON.parse(String(init.body)).query)
        return new Response(JSON.stringify({ data: { shop: {}, orders: { nodes: [] } } }), {
          status: 200,
        })
      }) as unknown as typeof fetch,
    })

    await client.listOrders(staticShopifyAuth('acme', 'shpat_real'), {
      createdFrom: new Date('2026-07-01T00:00:00Z'),
    })

    const whole = asked.join('\n')
    expect(whole).toContain('orders(')

    // One field has "customer" in its name and is not about the person: the
    // journey summary, which we ask a single thing of — which page of the shop
    // the visit that led to the order started on. It is checked on its own
    // terms and then set aside, so the sweep below cannot be passed by hiding a
    // shopper's details inside it.
    const journey = whole.match(/customerJourneySummary\s*\{[^}]*\{[^}]*\}\s*\}/)?.[0] ?? ''
    expect(journey).toContain('landingPage')
    expect(journey.replace(/customerJourneySummary|lastVisit|landingPage|[{}\s]/g, '')).toBe('')

    const query = whole.replace(journey, '')
    for (const forbidden of [
      'customer',
      'email',
      'phone',
      'billingAddress',
      'shippingAddress',
      'clientIp',
      'browserIp',
      'note',
      'customAttributes',
      'discountCode',
      'localizedFields',
    ]) {
      expect(query).not.toContain(forbidden)
    }
  })
})

describe('the one door every request to a store goes through', () => {
  /** A Shopify that answers whatever the test says, and records what it was asked. */
  function transport(
    respond: (call: { token: string; body: { query: string; variables?: unknown } }) => Response,
    options: { maxThrottleRetries?: number } = {},
  ): {
    client: ShopifyGraphqlClient
    calls: { token: string; body: { query: string; variables?: unknown } }[]
  } {
    const calls: { token: string; body: { query: string; variables?: unknown } }[] = []
    const client = new ShopifyGraphqlClient({
      storeBaseUrl: (shop) => `https://${shop}.myshopify.test`,
      limiter: { sleep: async () => {} },
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers)
        const call = {
          token: headers.get('x-shopify-access-token') ?? '',
          body: JSON.parse(String(init?.body ?? '{}')) as { query: string; variables?: unknown },
        }
        calls.push(call)
        return respond(call)
      },
      ...options,
    })
    return { client, calls }
  }

  const ok = (data: unknown, extensions?: unknown): Response =>
    new Response(JSON.stringify({ data, ...(extensions ? { extensions } : {}) }), { status: 200 })

  /** An auth that can renew once, the way a stored connection does. */
  function renewable(first: string, replacement: string | undefined): ShopifyAuth & { rejected: string[] } {
    const rejected: string[] = []
    return {
      shop: 'acme',
      rejected,
      accessToken: async () => first,
      refreshed: async (token: string) => {
        rejected.push(token)
        return replacement
      },
    }
  }

  it('renews a token Shopify refuses and sends the request again', async () => {
    const auth = renewable('stale', 'fresh')
    const { client, calls } = transport((call) =>
      call.token === 'fresh' ? ok({ shop: { name: 'Acme' } }) : new Response('{}', { status: 401 }),
    )

    const data = await client.request<{ shop: { name: string } }>(auth, { query: 'query { shop { name } }' })

    expect(data.shop.name).toBe('Acme')
    expect(calls.map((call) => call.token)).toEqual(['stale', 'fresh'])
    // The renewal was asked about the token that was actually refused, so a
    // token another worker replaced in the meantime is not thrown away.
    expect(auth.rejected).toEqual(['stale'])
  })

  it('treats a refusal it cannot renew past as the merchant’s to fix', async () => {
    const { client, calls } = transport(() => new Response('{}', { status: 401 }))

    const error = await client
      .request(staticShopifyAuth('acme', 'stale'), { query: 'query { shop { name } }' })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ShopifyTokenInvalid)
    expect(calls).toHaveLength(1)
    // The token itself never travels in an error. A fingerprint is enough to
    // ask "was it this one?" against a token saved since.
    expect((error as ShopifyTokenInvalid).rejectedToken).toBe(tokenFingerprint('stale'))
    expect((error as ShopifyTokenInvalid).rejectedToken).not.toContain('stale')
  })

  it('renews once and not forever when the replacement is refused too', async () => {
    const auth = renewable('stale', 'also-stale')
    const { client, calls } = transport(() => new Response('{}', { status: 401 }))

    await expect(client.request(auth, { query: 'query { shop { name } }' })).rejects.toBeInstanceOf(
      ShopifyTokenInvalid,
    )
    expect(calls).toHaveLength(2)
    expect(auth.rejected).toEqual(['stale'])
  })

  it('does not treat a permission we were never given as a dead token', async () => {
    // The commonest case is order data before Shopify has approved our access
    // to it. Sending that merchant to reconnect would be advice that cannot
    // possibly work.
    const auth = renewable('good', 'renewed')
    const { client, calls } = transport(() => new Response('{}', { status: 403 }))

    const error = await client.request(auth, { query: 'query { orders { id } }' }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ShopifyAccessDenied)
    expect(error).not.toBeInstanceOf(ShopifyTokenInvalid)
    expect(error).toMatchObject({ retryable: false, errorClass: 'shopify_access_denied' })
    // No renewal was attempted: there was nothing wrong with the token.
    expect(calls).toHaveLength(1)
    expect(auth.rejected).toEqual([])
  })

  it('reads the same refusal out of an answer Shopify calls a success', async () => {
    const { client } = transport(
      () =>
        new Response(
          JSON.stringify({
            errors: [{ message: 'Access denied for orders field.', extensions: { code: 'ACCESS_DENIED' } }],
          }),
          { status: 200 },
        ),
    )

    await expect(
      client.request(staticShopifyAuth('acme', 'good'), { query: 'query { orders { id } }' }),
    ).rejects.toBeInstanceOf(ShopifyAccessDenied)
  })

  it('says a frozen, locked or closed store is neither our token nor a retry', async () => {
    for (const status of [402, 423, 404]) {
      const { client } = transport(() => new Response('{}', { status }))
      const error = await client
        .request(staticShopifyAuth('acme', 'good'), { query: 'query { shop { name } }' })
        .catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ShopifyStoreUnavailable)
      expect(error).toMatchObject({ status, retryable: false })
    }
  })

  it('refuses to answer at all when Shopify ignored part of a search', async () => {
    // Shopify does not fail an unrecognised filter; it drops it and warns. The
    // answer that comes back is then a wider one wearing the shape of the
    // narrow question, which is how "nothing since Tuesday" gets written down.
    const ignored = {
      search: [{ warnings: [{ field: 'created_at', message: 'is not supported' }] }],
    }
    const { client } = transport(() => ok({ articles: { nodes: [] } }, ignored))

    const error = await client
      .request(staticShopifyAuth('acme', 'good'), {
        query: 'query { articles { nodes { id } } }',
        strictSearch: true,
      })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ShopifyQueryRejected)
    expect(error).toMatchObject({ retryable: false, errorClass: 'shopify_search_ignored' })
  })

  it('answers normally when the same warning arrives on a request that was not filtering', async () => {
    const { client } = transport(() =>
      ok({ articles: { nodes: [] } }, { search: [{ warnings: [{ field: 'q', message: 'ignored' }] }] }),
    )

    await expect(
      client.request(staticShopifyAuth('acme', 'good'), { query: 'query { articles { nodes { id } } }' }),
    ).resolves.toEqual({ articles: { nodes: [] } })
  })

  it('will not pass on half an answer', async () => {
    // Partial data alongside an error is still an error: a page silently
    // missing the field that failed would be written down as the truth.
    const { client } = transport(
      () =>
        new Response(
          JSON.stringify({
            data: { shop: { name: 'Acme' } },
            errors: [{ message: "Field 'ianaTimezone' doesn't exist" }],
          }),
          { status: 200 },
        ),
    )

    await expect(
      client.request(staticShopifyAuth('acme', 'good'), { query: 'query { shop { name } }' }),
    ).rejects.toBeInstanceOf(ShopifyQueryRejected)
  })

  it('waits out a throttle and goes again rather than failing the walk it is part of', async () => {
    let sent = 0
    const { client, calls } = transport(() => {
      sent += 1
      return sent === 1
        ? new Response('{}', { status: 429, headers: { 'retry-after': '0.2' } })
        : ok({ shop: { name: 'Acme' } })
    })

    await expect(
      client.request(staticShopifyAuth('acme', 'good'), { query: 'query { shop { name } }' }),
    ).resolves.toEqual({ shop: { name: 'Acme' } })
    expect(calls).toHaveLength(2)
  })

  it('gives up loudly when Shopify keeps throttling', async () => {
    const { client, calls } = transport(
      () => new Response('{}', { status: 429, headers: { 'retry-after': '0.2' } }),
      { maxThrottleRetries: 2 },
    )

    const error = await client
      .request(staticShopifyAuth('acme', 'good'), { query: 'query { shop { name } }' })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ShopifyApiFailure)
    expect(error).toMatchObject({ retryable: true, errorClass: 'shopify_rate_limited' })
    expect(calls).toHaveLength(3)
  })

  it('turns Shopify’s global ids into the numbers our own rows and its webhooks use', () => {
    expect(legacyIdOf('gid://shopify/Article/991')).toBe('991')
    expect(legacyIdOf('gid://shopify/ProductVariant/12?param=1')).toBe('12')
    expect(legacyIdOf(null)).toBe('')
    expect(gidOf('Blog', '77')).toBe('gid://shopify/Blog/77')
    expect(gidOf('Blog', 'gid://shopify/Blog/77')).toBe('gid://shopify/Blog/77')
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
    calls: { url: string; method: string; token: string | null; body: string }[]
  } {
    const calls: { url: string; method: string; token: string | null; body: string }[] = []
    const client = new ShopifyOAuthClient({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      storeBaseUrl: (shop) => `https://${shop}.myshopify.test`,
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers)
        calls.push({
          url: String(input),
          method: init?.method ?? 'GET',
          token: headers.get('x-shopify-access-token'),
          body: String(init?.body ?? ''),
        })
        return respond()
      },
    })
    return { client, calls }
  }

  it('deletes the current permissions, which is what an uninstall does', async () => {
    const { client, calls } = revoking(() => new Response('{"data":{"appUninstall":{}}}', { status: 200 }))
    await client.revokeAccess({ shop: 'acme', accessToken: 'shpat_real' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.body).toContain('appUninstall')
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

  it('does not call a refusal stated in the answer a success', async () => {
    // Shopify says 200 and then names the problem in the body. Believing the
    // status would leave a merchant uninstalled in our records and still
    // connected in theirs.
    const { client } = revoking(
      () =>
        new Response(
          JSON.stringify({ data: { appUninstall: { userErrors: [{ message: 'cannot uninstall' }] } } }),
          { status: 200 },
        ),
    )

    await expect(client.revokeAccess({ shop: 'acme', accessToken: 't' })).rejects.toBeInstanceOf(
      ShopifyOAuthFailure,
    )
  })
})

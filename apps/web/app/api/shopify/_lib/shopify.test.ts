import { describe, expect, it } from 'vitest'
import { accountScope } from '@sortiva/db'
import { SHOPIFY_READ_SCOPES, type StoreConnection } from '@sortiva/core'
import { MockShopifyOAuthClient } from '@sortiva/providers'
import { CALLBACK_CODES, START_CODES, makeCallbackHandler, makeStartHandler, type ShopifyOauthDeps } from './handlers'
import { signOauthState, verifyOauthState } from './state'

/**
 * The install handshake as the merchant's browser experiences it.
 *
 * Every case here is about somebody arriving at the callback who should not
 * finish it: a forged signature, a state from another account, a store name that
 * does not match, a grant carrying write permission. Each has to end without a
 * token being stored.
 */

const SECRET = 'app-secret'
const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const OTHER_ACCOUNT = '22222222-2222-4222-8222-222222222222'

interface Harness {
  deps: ShopifyOauthDeps
  oauth: MockShopifyOAuthClient
  saved: { accountId: string; shopHandle: string; accessToken: string; grantedScopes: readonly string[] }[]
  resumed: string[]
}

function harness(overrides: Partial<ShopifyOauthDeps> = {}): Harness {
  const oauth = new MockShopifyOAuthClient(SECRET)
  const saved: Harness['saved'] = []
  const resumed: string[] = []

  const deps: ShopifyOauthDeps = {
    oauth,
    stateSecret: SECRET,
    redirectUri: 'https://app.example/api/shopify/oauth/callback',
    dashboardUrl: 'https://app.example/dashboard',
    async readShopHandle() {
      return 'acme'
    },
    async saveConnection(input): Promise<StoreConnection> {
      saved.push(input)
      return {
        accountId: input.accountId,
        shopHandle: input.shopHandle,
        grantedScopes: input.grantedScopes,
        connectedAt: new Date(),
        invalidatedAt: null,
      }
    },
    async resumeIngestion(accountId) {
      resumed.push(accountId)
    },
    ...overrides,
  }

  return { deps, oauth, saved, resumed }
}

function callbackRequest(query: Record<string, string>): Request {
  const url = new URL('https://app.example/api/shopify/oauth/callback')
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  return new Request(url, { method: 'GET' })
}

function context(accountId = ACCOUNT) {
  return { scope: accountScope(accountId), route: undefined }
}

describe('starting the install', () => {
  it('sends the merchant to a consent screen asking for read permission only', async () => {
    const h = harness()
    const response = await makeStartHandler(() => h.deps)(
      new Request('https://app.example/api/shopify/oauth/start', { method: 'POST' }),
      context(),
    )

    const body = (await response.json()) as { url: string }
    const url = new URL(body.url)

    expect(url.host).toBe('acme.myshopify.com')
    expect(url.searchParams.get('scope')).toBe(SHOPIFY_READ_SCOPES.join(','))
    expect(body.url).not.toContain('write_')
  })

  it('waits rather than guessing when we do not yet know the store', async () => {
    const h = harness({ readShopHandle: async () => undefined })
    const response = await makeStartHandler(() => h.deps)(
      new Request('https://app.example/api/shopify/oauth/start', { method: 'POST' }),
      context(),
    )

    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      START_CODES.notDetectedYet,
    )
  })
})

describe('coming back from Shopify', () => {
  function goodQuery(h: Harness, accountId = ACCOUNT): Record<string, string> {
    const state = signOauthState({ accountId, shop: 'acme', issuedAt: Date.now() }, SECRET)
    return h.oauth.signCallback({
      shop: 'acme.myshopify.com',
      code: 'one-time',
      state,
      timestamp: '1756000000',
    })
  }

  it('stores the connection and picks onboarding back up', async () => {
    const h = harness()
    const response = await makeCallbackHandler(() => h.deps)(callbackRequest(goodQuery(h)), context())

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://app.example/dashboard?connected=shopify')
    expect(h.saved).toHaveLength(1)
    expect(h.saved[0]).toMatchObject({ accountId: ACCOUNT, shopHandle: 'acme', accessToken: 'shpat_mock_token' })
    expect(h.resumed).toEqual([ACCOUNT])
  })

  it('refuses a callback Shopify did not sign', async () => {
    const h = harness()
    const query = { ...goodQuery(h), hmac: 'deadbeef' }

    const response = await makeCallbackHandler(() => h.deps)(callbackRequest(query), context())

    expect(response.headers.get('location')).toContain(CALLBACK_CODES.badSignature)
    expect(h.saved).toHaveLength(0)
  })

  it('refuses a state issued for somebody else', async () => {
    const h = harness()
    const query = goodQuery(h, OTHER_ACCOUNT)

    const response = await makeCallbackHandler(() => h.deps)(callbackRequest(query), context(ACCOUNT))

    expect(response.headers.get('location')).toContain(CALLBACK_CODES.badState)
    expect(h.saved).toHaveLength(0)
  })

  it('refuses a store that is not the one the handshake was started for', async () => {
    const h = harness()
    const state = signOauthState({ accountId: ACCOUNT, shop: 'acme', issuedAt: Date.now() }, SECRET)
    const query = h.oauth.signCallback({ shop: 'someone-else.myshopify.com', code: 'c', state })

    const response = await makeCallbackHandler(() => h.deps)(callbackRequest(query), context())

    expect(response.headers.get('location')).toContain(CALLBACK_CODES.wrongStore)
    expect(h.saved).toHaveLength(0)
  })

  it('drops a token that came back able to write to the store', async () => {
    const h = harness()
    h.oauth.grants({ grantedScopes: ['read_products', 'write_content'] })

    const response = await makeCallbackHandler(() => h.deps)(callbackRequest(goodQuery(h)), context())

    expect(response.headers.get('location')).toContain(CALLBACK_CODES.writeScope)
    // The screen said this permission cannot change anything in their store.
    expect(h.saved).toHaveLength(0)
  })

  it('does not turn a Shopify outage into a lost connection', async () => {
    const h = harness()
    h.oauth.failsWith(new Error('shopify is down'))

    const response = await makeCallbackHandler(() => h.deps)(callbackRequest(goodQuery(h)), context())

    expect(response.headers.get('location')).toContain(CALLBACK_CODES.exchangeFailed)
    expect(h.saved).toHaveLength(0)
  })

  it('still reports success when picking onboarding back up fails', async () => {
    const h = harness({
      resumeIngestion: async () => {
        throw new Error('queue unavailable')
      },
    })

    const response = await makeCallbackHandler(() => h.deps)(callbackRequest(goodQuery(h)), context())

    expect(response.headers.get('location')).toContain('connected=shopify')
    expect(h.saved).toHaveLength(1)
  })

  it('refuses a callback missing the parameters it needs', async () => {
    const h = harness()
    const response = await makeCallbackHandler(() => h.deps)(
      callbackRequest({ shop: 'acme.myshopify.com' }),
      context(),
    )

    expect(response.headers.get('location')).toContain(CALLBACK_CODES.missingParams)
  })
})

describe('the state value we send out and get back', () => {
  const now = new Date('2026-09-01T12:00:00Z')

  it('round-trips for the account it was issued to', () => {
    const state = signOauthState({ accountId: ACCOUNT, shop: 'acme', issuedAt: now.getTime() }, SECRET)
    const verified = verifyOauthState(state, SECRET, { accountId: ACCOUNT, now })

    expect(verified).toMatchObject({ ok: true, state: { shop: 'acme' } })
  })

  it('is useless in somebody else’s session', () => {
    const state = signOauthState({ accountId: ACCOUNT, shop: 'acme', issuedAt: now.getTime() }, SECRET)
    expect(verifyOauthState(state, SECRET, { accountId: OTHER_ACCOUNT, now })).toEqual({
      ok: false,
      reason: 'wrong_account',
    })
  })

  it('cannot be forged without the secret', () => {
    const state = signOauthState({ accountId: ACCOUNT, shop: 'acme', issuedAt: now.getTime() }, 'other-secret')
    expect(verifyOauthState(state, SECRET, { accountId: ACCOUNT, now })).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
  })

  it('stops working once the merchant has been away too long', () => {
    const state = signOauthState({ accountId: ACCOUNT, shop: 'acme', issuedAt: now.getTime() }, SECRET)
    const later = new Date(now.getTime() + 30 * 60 * 1000)

    expect(verifyOauthState(state, SECRET, { accountId: ACCOUNT, now: later })).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('rejects something that is not one of ours at all', () => {
    expect(verifyOauthState('nonsense', SECRET, { accountId: ACCOUNT, now })).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })
})

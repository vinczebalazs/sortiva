import { describe, expect, it } from 'vitest'
import { GSC_READONLY_SCOPE, GscGrantRevoked, GscRequestFailure } from '@sortiva/core'
import { GscOAuthProvider } from './client'

const credentials = { clientId: 'client-id', clientSecret: 'client-secret' }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('the consent we ask Google for', () => {
  it('asks for read access and nothing else', () => {
    const provider = new GscOAuthProvider(credentials)
    const url = new URL(
      provider.authorizationUrl({ state: 'abc', redirectUri: 'https://app.test/api/gsc/oauth/callback' }),
    )
    expect(url.searchParams.get('scope')).toBe(GSC_READONLY_SCOPE)
    expect(url.searchParams.get('scope')).not.toContain('webmasters ')
    expect(url.searchParams.get('state')).toBe('abc')
  })

  it('forces the consent screen, because that is the only way Google issues a renewable grant', () => {
    const provider = new GscOAuthProvider(credentials)
    const url = new URL(provider.authorizationUrl({ state: 'abc', redirectUri: 'https://app.test/cb' }))
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
  })

  it('refuses to start a connection we have no credentials to finish', () => {
    const provider = new GscOAuthProvider({ clientId: '', clientSecret: '' })
    expect(() => provider.authorizationUrl({ state: 'a', redirectUri: 'https://app.test/cb' })).toThrow(
      GscRequestFailure,
    )
  })
})

describe('exchanging and renewing the grant', () => {
  it('turns Google’s lifetime into an instant the sync can check', async () => {
    const provider = new GscOAuthProvider({
      ...credentials,
      now: () => Date.parse('2026-09-02T00:00:00Z'),
      fetchImpl: async () =>
        jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3599, scope: GSC_READONLY_SCOPE }),
    })
    const tokens = await provider.exchangeCode({ code: 'c', redirectUri: 'https://app.test/cb' })
    expect(tokens.accessToken).toBe('at')
    expect(tokens.refreshToken).toBe('rt')
    expect(tokens.expiresAt.toISOString()).toBe('2026-09-02T00:59:59.000Z')
  })

  it('reports a missing refresh token as absent rather than inventing one', async () => {
    const provider = new GscOAuthProvider({
      ...credentials,
      fetchImpl: async () => jsonResponse({ access_token: 'at', expires_in: 3600 }),
    })
    const tokens = await provider.exchangeCode({ code: 'c', redirectUri: 'https://app.test/cb' })
    expect(tokens.refreshToken).toBeNull()
  })

  it('tells a dead grant apart from a bad day, because the answers differ', async () => {
    const revoked = new GscOAuthProvider({
      ...credentials,
      fetchImpl: async () => jsonResponse({ error: 'invalid_grant' }, 400),
    })
    await expect(revoked.refresh('rt')).rejects.toBeInstanceOf(GscGrantRevoked)

    const flaky = new GscOAuthProvider({
      ...credentials,
      fetchImpl: async () => jsonResponse({ error: 'backend_error' }, 503),
    })
    await expect(flaky.refresh('rt')).rejects.toMatchObject({ retryable: true })

    const offline = new GscOAuthProvider({
      ...credentials,
      fetchImpl: async () => {
        throw new Error('ECONNRESET')
      },
    })
    await expect(offline.refresh('rt')).rejects.toMatchObject({
      retryable: true,
      errorClass: 'gsc_transport',
    })
  })
})

describe('reading the report', () => {
  it('flattens Google’s parallel key array into named fields', async () => {
    const provider = new GscOAuthProvider({
      ...credentials,
      fetchImpl: async () =>
        jsonResponse({
          rows: [
            {
              keys: ['2026-08-31', 'https://example.com/a', 'trail shoes', 'DESKTOP', 'usa'],
              clicks: 3,
              impressions: 40,
              position: 7.25,
            },
            // A row Google shaped differently from what we asked for. Dropped
            // rather than guessed at: a misaligned key array would write one
            // page's numbers against another page's URL.
            { keys: ['2026-08-31'], clicks: 1, impressions: 1, position: 1 },
          ],
        }),
    })

    const page = await provider.searchAnalytics('at', {
      siteUrl: 'sc-domain:example.com',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
    })

    expect(page.rows).toEqual([
      {
        date: '2026-08-31',
        page: 'https://example.com/a',
        query: 'trail shoes',
        device: 'DESKTOP',
        country: 'usa',
        clicks: 3,
        impressions: 40,
        position: 7.25,
      },
    ])
    expect(page.hasMore).toBe(false)
  })

  it('escapes the property in the path, so a domain property is not read as a route', async () => {
    let seen = ''
    const provider = new GscOAuthProvider({
      ...credentials,
      fetchImpl: async (input) => {
        seen = String(input)
        return jsonResponse({ rows: [] })
      },
    })
    await provider.searchAnalytics('at', {
      siteUrl: 'https://example.com/shop/',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
    })
    expect(seen).toContain('/sites/https%3A%2F%2Fexample.com%2Fshop%2F/searchAnalytics/query')
  })

  it('treats a refusal of our access as "reconnect", not as a retry', async () => {
    for (const status of [401, 403]) {
      const provider = new GscOAuthProvider({
        ...credentials,
        fetchImpl: async () => jsonResponse({ error: {} }, status),
      })
      await expect(provider.listSites('at')).rejects.toBeInstanceOf(GscGrantRevoked)
    }
  })

  it('lists the properties the Google account can read', async () => {
    const provider = new GscOAuthProvider({
      ...credentials,
      fetchImpl: async () =>
        jsonResponse({
          siteEntry: [
            { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
            { permissionLevel: 'siteOwner' },
          ],
        }),
    })
    expect(await provider.listSites('at')).toEqual([
      { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
    ])
  })
})

describe('handing the grant back', () => {
  it('posts the token to Google’s revoke endpoint', async () => {
    const calls: { url: string; body: string }[] = []
    const provider = new GscOAuthProvider({
      ...credentials,
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), body: String(init?.body ?? '') })
        return new Response('', { status: 200 })
      },
    })
    await provider.revoke('refresh-token')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/revoke')
    expect(new URLSearchParams(calls[0]!.body).get('token')).toBe('refresh-token')
  })

  it('treats a token Google has already forgotten as done', async () => {
    // Google answers 400 for an unknown token. The grant is gone, which is the
    // outcome asked for — and it is what makes the deletion job safe to retry.
    const provider = new GscOAuthProvider({
      ...credentials,
      fetchImpl: async () => new Response('{"error":"invalid_token"}', { status: 400 }),
    })
    await expect(provider.revoke('already-gone')).resolves.toBeUndefined()
  })

  it('raises a retryable failure when Google is broken', async () => {
    const provider = new GscOAuthProvider({
      ...credentials,
      fetchImpl: async () => new Response('', { status: 503 }),
    })
    await expect(provider.revoke('token')).rejects.toBeInstanceOf(GscRequestFailure)
    await expect(provider.revoke('token')).rejects.toMatchObject({ retryable: true })
  })
})

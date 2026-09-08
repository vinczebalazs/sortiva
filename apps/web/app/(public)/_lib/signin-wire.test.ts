import NextAuth from 'next-auth'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requestGoogleSignIn, SIGN_IN_GOOGLE_ENDPOINT } from '@sortiva/ui'
import { buildAuthAdapter, type AuthUserStore } from '../../api/auth/_lib/adapter'
import { buildAuthConfig } from '../../api/auth/_lib/config'
import { memorySessionStore } from '../../api/auth/_lib/memorySessions'

/**
 * **The Google sign-in button, wired to the real sign-in library.**
 *
 * On a deployed server the button did not work at all. It submitted a plain
 * form carrying only where to land afterwards, and the sign-in library refuses
 * a post that does not carry the anti-forgery token it hands out — so a
 * merchant reaching the sign-in screen could not get past it, and everything
 * behind it was unreachable. This is the test that a press now reaches Google.
 *
 * It runs the exchange the press runs — `requestGoogleSignIn`, the shared
 * component package's own function — against the real Auth.js handlers built
 * from the real sign-in configuration. Nothing on the answering side is
 * stubbed: the provider registration, the anti-forgery check and the
 * authorization URL Google is handed are the ones the deployed app produces.
 * Google itself is not called; what a press has to get right ends at handing
 * the browser Google's address.
 *
 * **Every assertion here is on the destination, never on the status.** A
 * refused sign-in comes back `200` with an error page named as where to go, so
 * a check written against the status passes on a completely broken sign-in —
 * which is how the broken button shipped. The `records a 200` test below pins
 * that down, so anyone tempted to simplify these assertions to `response.ok`
 * can see why it would prove nothing.
 *
 * The one link a test in this repository cannot drive is React dispatching the
 * click, because there is no browser-DOM test environment here; the button's
 * handler is a single call to the function below.
 */

const ORIGIN = 'http://localhost:3000'
const GOOGLE_CLIENT_ID = 'google-client-id-from-config'

/** Carries cookies between requests the way a browser would. */
class Browser {
  private readonly values = new Map<string, string>()

  absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';')[0]!
      const eq = pair.indexOf('=')
      const name = pair.slice(0, eq)
      const value = pair.slice(eq + 1)
      if (value === '') this.values.delete(name)
      else this.values.set(name, value)
    }
  }

  cookie(name: string): string | undefined {
    const value = this.values.get(name)
    return value === undefined ? undefined : decodeURIComponent(value)
  }

  get header(): string {
    return [...this.values].map(([name, value]) => `${name}=${value}`).join('; ')
  }
}

function harness() {
  const accounts = new Map<string, string>()
  const users: AuthUserStore = {
    async findByEmail(email) {
      for (const [id, address] of accounts) if (address === email) return { id, email }
      return undefined
    },
    async findById(id) {
      const email = accounts.get(id)
      return email ? { id, email } : undefined
    },
  }

  const sessions = memorySessionStore(users)
  const config = buildAuthConfig({
    adapter: buildAuthAdapter({
      tokens: {
        async create() {},
        async use() {
          return undefined
        },
      },
      users,
      sessions: sessions.store,
      provisioning: {
        store: {
          async createOrFindByEmail(email: string) {
            for (const [id, address] of accounts) {
              if (address === email) return { accountId: id, created: false }
            }
            const accountId = `acct_${accounts.size + 1}`
            accounts.set(accountId, email)
            return { accountId, created: true }
          },
        },
      },
    }),
    revokeAllSessions: async (accountId) => {
      await sessions.store.removeAllForAccount(accountId)
    },
  })

  const { handlers } = NextAuth({ ...config, logger: { error() {}, warn() {}, debug() {} } })

  /**
   * A `fetch` that answers from the real sign-in handlers, for one browser's
   * cookies. This is what the screen is handed in a page; there it is the
   * browser's own `fetch` and the cookies travel by themselves.
   */
  function fetchFor(browser: Browser): typeof globalThis.fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers((init?.headers ?? {}) as Record<string, string>)
      if (browser.header) headers.set('cookie', browser.header)
      const request = new Request(`${ORIGIN}${String(input)}`, {
        method: init?.method ?? 'GET',
        headers,
        ...(init?.body ? { body: init.body as string } : {}),
      })
      const response =
        request.method === 'POST'
          ? await handlers.POST(request as never)
          : await handlers.GET(request as never)
      browser.absorb(response)
      return response
    }) as unknown as typeof globalThis.fetch
  }

  return { fetchFor, visitor: () => new Browser() }
}

/**
 * Google's own description of where its sign-in endpoints are, as it served it
 * on 2026-09-08.
 *
 * It is here because the sign-in library reads it **over the real internet**
 * before it can build a sign-in URL, using the process's own `fetch` rather
 * than the one this file hands the screen. So every run of these tests made a
 * live request to Google, and this file failed intermittently for weeks —
 * always at exactly the runner's five-second limit, always on work that takes
 * about four hundred milliseconds when it passes. Measured from this machine
 * while idle, that request takes around 230 ms; alongside three hundred other
 * test files it does not.
 *
 * A unit test that cannot run without a vendor being up and quick is not a
 * unit test. Nothing about the sign-in library's own behaviour is stubbed —
 * only the document it would have fetched.
 */
const GOOGLE_DISCOVERY = {
  issuer: 'https://accounts.google.com',
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
  userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
  jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
  response_types_supported: ['code', 'token', 'id_token', 'none'],
  subject_types_supported: ['public'],
  id_token_signing_alg_values_supported: ['RS256'],
  scopes_supported: ['openid', 'email', 'profile'],
  token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
  claims_supported: ['aud', 'email', 'email_verified', 'exp', 'iss', 'name', 'picture', 'sub'],
  code_challenge_methods_supported: ['plain', 'S256'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
}

const DISCOVERY_URL = 'https://accounts.google.com/.well-known/openid-configuration'

let realFetch: typeof globalThis.fetch

beforeEach(() => {
  // Answer the one document the library needs, and refuse everything else by
  // name. The refusal is the more useful half: if this file ever starts
  // reaching somewhere new, it says where instead of hanging until the timeout.
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === DISCOVERY_URL) {
      return new Response(JSON.stringify(GOOGLE_DISCOVERY), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`signin-wire.test.ts tried to reach ${url}; these tests make no network calls`)
  }) as typeof globalThis.fetch

  process.env.AUTH_SECRET = 'test-secret-not-used-anywhere-real'
  process.env.AUTH_GOOGLE_ID = GOOGLE_CLIENT_ID
  process.env.AUTH_GOOGLE_SECRET = 'google-client-secret-not-used-anywhere-real'
  delete process.env.AUTH_URL
  delete process.env.NEXTAUTH_URL
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('pressing “Continue with Google” on the sign-in screen', () => {
  it('hands the browser to Google, as this deployment’s own client', async () => {
    const h = harness()

    const outcome = await requestGoogleSignIn({ fetch: h.fetchFor(h.visitor()) })

    expect(outcome.kind).toBe('handshake_started')
    const destination = new URL(outcome.kind === 'handshake_started' ? outcome.url : '')
    expect(destination.origin).toBe('https://accounts.google.com')
    expect(destination.searchParams.get('client_id')).toBe(GOOGLE_CLIENT_ID)
    // Where Google sends the browser back to. Wrong here and the merchant
    // never returns, whatever they do on Google's screen.
    expect(destination.searchParams.get('redirect_uri')).toBe(
      `${ORIGIN}/api/auth/callback/google`,
    )
    // Identity only — Search Console is a separate consent, asked for later.
    expect(destination.searchParams.get('scope')).toBe('openid email profile')
  })

  it('keeps the place the visitor asked to land', async () => {
    const h = harness()
    const visitor = h.visitor()

    await requestGoogleSignIn({ fetch: h.fetchFor(visitor), callbackUrl: '/settings/publishing' })

    // The library holds it across the trip to Google in a cookie of its own —
    // a link parameter would not survive leaving our site and coming back.
    expect(visitor.cookie('authjs.callback-url')).toBe(`${ORIGIN}/settings/publishing`)
  })

  it('reports a failure, and goes nowhere, when the anti-forgery token is refused', async () => {
    const h = harness()
    const visitor = h.visitor()
    const real = h.fetchFor(visitor)

    // Auth.js refuses a sign-in whose token does not match the cookie it
    // issued. This is exactly what the old form sent — nothing at all — so a
    // press that ends here is the defect this card fixes, reproduced.
    const tampered = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/csrf')) {
        await real(input, init)
        return new Response(JSON.stringify({ csrfToken: 'not-the-issued-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return real(input, init)
    }) as unknown as typeof globalThis.fetch

    expect(await requestGoogleSignIn({ fetch: tampered })).toEqual({ kind: 'failed' })
  })

  it('records that the library says no with a 200, so no test here may trust one', async () => {
    const h = harness()
    const visitor = h.visitor()

    // The form the screen used to render: a post with a landing place and no
    // token. This is the request that broke sign-in on every deployed server.
    const refused = await h.fetchFor(visitor)(SIGN_IN_GOOGLE_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'X-Auth-Return-Redirect': '1',
      },
      body: new URLSearchParams({ callbackUrl: '/plan' }).toString(),
    })

    expect(refused.status, 'a refused sign-in is not an error status').toBe(200)
    expect(refused.ok, 'and `ok` is true, which is why the defect went unnoticed').toBe(true)

    const { url } = (await refused.json()) as { url: string }
    // The whole tell is here: the library names its own screen, with the
    // reason. Nothing left our site, and nobody signed in.
    expect(new URL(url).pathname).toBe('/api/auth/signin')
    expect(new URL(url).searchParams.get('error')).toBe('MissingCSRF')
  })
})

import { randomUUID } from 'node:crypto'
import NextAuth from 'next-auth'
import { beforeEach, describe, expect, it } from 'vitest'
import { requestSignOut } from '@sortiva/ui'
import { buildAuthAdapter, type AuthUserStore } from '../../api/auth/_lib/adapter'
import { buildAuthConfig } from '../../api/auth/_lib/config'
import { memorySessionStore } from '../../api/auth/_lib/memorySessions'
import { sessionTokenDigest } from '../../api/auth/_lib/sessionToken'

/**
 * **The sign-out control, wired to the real sign-in library.**
 *
 * The product gained the ability to end every session an account has before any
 * screen could ask for it. This is the test that the button now on screen
 * actually reaches it: it runs the exchange the button's press runs —
 * `requestSignOut`, the shared component package's own function — against the
 * real Auth.js handlers, with two browsers holding two different sessions for
 * one account, and then asks the second browser whether it is still signed in.
 *
 * Nothing here is stubbed on the answering side: the sign-in configuration, the
 * anti-forgery check, the session read, the delete and the fan-out to the
 * account's other sessions are all the ones the deployed app runs. Storage is a
 * Map — where the *library* ends a session is what is under test, and the SQL
 * behind that Map has its own suite in `packages/db`.
 *
 * The one link a test in this repository cannot drive is React dispatching the
 * click, because there is no browser-DOM test environment here; the button's
 * handler is a single call to the function below.
 */

const ORIGIN = 'http://localhost:3000'
const SESSION_COOKIE = 'authjs.session-token'

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

  set(name: string, value: string): void {
    this.values.set(name, value)
  }

  get header(): string {
    return [...this.values].map(([name, value]) => `${name}=${value}`).join('; ')
  }
}

function harness() {
  const accounts = new Map<string, string>([
    ['acct_1', 'founder@example.com'],
    ['acct_2', 'someone@example.com'],
  ])
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
   * cookies. This is what the control is handed in a page; there it is the
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

  /** A browser already signed in, the way one arriving at the app is. */
  async function signedIn(accountId: string): Promise<Browser> {
    const cookie = randomUUID()
    const browser = new Browser()
    browser.set(SESSION_COOKIE, cookie)
    await sessions.store.create({
      accountId,
      tokenDigest: sessionTokenDigest(cookie),
      expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    })
    return browser
  }

  /** Who the library says this browser is, asked exactly as a signed-in page asks. */
  async function signedInAs(browser: Browser): Promise<string | undefined> {
    const response = await fetchFor(browser)('/api/auth/session')
    const body = (await response.json()) as { user?: { id?: string } } | null
    return body?.user?.id
  }

  return { sessions, fetchFor, signedIn, signedInAs }
}

beforeEach(() => {
  process.env.AUTH_SECRET = 'test-secret-not-used-anywhere-real'
  delete process.env.AUTH_URL
  delete process.env.NEXTAUTH_URL
})

describe('pressing sign out in the app shell', () => {
  it('ends the session in the browser that pressed it', async () => {
    const h = harness()
    const laptop = await h.signedIn('acct_1')
    expect(await h.signedInAs(laptop)).toBe('acct_1')

    const outcome = await requestSignOut({ fetch: h.fetchFor(laptop) })

    expect(outcome.kind).toBe('signed_out')
    expect(await h.signedInAs(laptop)).toBeUndefined()
  })

  it('ends the session in a browser that never touched the button', async () => {
    const h = harness()
    const laptop = await h.signedIn('acct_1')
    const phone = await h.signedIn('acct_1')
    expect(await h.signedInAs(phone), 'both browsers start signed in').toBe('acct_1')

    await requestSignOut({ fetch: h.fetchFor(laptop) })

    // This is the whole point of the control: a merchant signing out because a
    // laptop went missing means stop, everywhere, not "stop on this device".
    expect(await h.signedInAs(phone)).toBeUndefined()
    expect(h.sessions.rows.size).toBe(0)
  })

  it('leaves other people signed in', async () => {
    const h = harness()
    const leaving = await h.signedIn('acct_1')
    const stranger = await h.signedIn('acct_2')

    await requestSignOut({ fetch: h.fetchFor(leaving) })

    expect(await h.signedInAs(leaving)).toBeUndefined()
    expect(await h.signedInAs(stranger), 'a different account').toBe('acct_2')
  })

  it('sends the merchant on somewhere public rather than back into the app', async () => {
    const h = harness()
    const outcome = await requestSignOut({ fetch: h.fetchFor(await h.signedIn('acct_1')) })

    expect(outcome.kind === 'signed_out' && new URL(outcome.url).pathname).toBe('/')
  })

  it('reports a failure, and revokes nothing, when the anti-forgery token is refused', async () => {
    const h = harness()
    const laptop = await h.signedIn('acct_1')
    const real = h.fetchFor(laptop)

    // Auth.js rejects a sign-out whose token does not match the cookie it
    // issued. Every session must survive that, or a failed press would have
    // signed the merchant out of everything while telling them it did not.
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

    expect(await requestSignOut({ fetch: tampered })).toEqual({ kind: 'failed' })
    expect(await h.signedInAs(laptop)).toBe('acct_1')
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import NextAuth from 'next-auth'
import {
  requestAccountDeletion,
  type AccountLifecycleStore,
  type AccountStore,
  type EmailMessage,
  type EmailProvider,
} from '@sortiva/core'
import { buildAuthAdapter, type AuthUserStore, type VerificationTokenStore } from './adapter'
import { buildAuthConfig } from './config'
import { memorySessionStore } from './memorySessions'
import { sessionTokenDigest } from './sessionToken'
import { sendSignInLinkVia } from './signInEmail'

/**
 * A session can now be ended before it lapses. These prove the three ways that
 * has to work, by actually trying to use a session afterwards rather than by
 * inspecting what was deleted:
 *
 *  - a copy of somebody's cookie stops working the moment the session is revoked;
 *  - signing out in one browser signs the other one out too;
 *  - asking to have the account deleted signs every browser out at once.
 *
 * Driven through the real Auth.js handlers, because where a session is read,
 * refreshed and destroyed is decided inside the library. Storage and the mail
 * vendor are in memory; the same operations against real SQL are proved in
 * `packages/db/src/repositories/sessions.test.ts`.
 */

const ORIGIN = 'http://localhost:3000'
const SESSION_COOKIE = 'authjs.session-token'

/** Carries cookies between requests the way a browser would. */
class Jar {
  private readonly values = new Map<string, string>()

  absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';')
      const eq = pair!.indexOf('=')
      const name = pair!.slice(0, eq)
      const value = pair!.slice(eq + 1)
      if (value === '') this.values.delete(name)
      else this.values.set(name, value)
    }
  }

  get header(): string {
    return [...this.values].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  value(name: string): string | undefined {
    return this.values.get(name)
  }

  /** A second browser holding a copy of this one's session cookie, and nothing else. */
  copyOfSessionCookie(): Jar {
    const copy = new Jar()
    copy.values.set(SESSION_COOKIE, this.values.get(SESSION_COOKIE)!)
    return copy
  }
}

function harness() {
  const tokenRows: { identifier: string; token: string; expires: Date }[] = []
  const tokens: VerificationTokenStore = {
    async create(input) {
      tokenRows.push({ ...input })
    },
    async use({ identifier, token }) {
      const index = tokenRows.findIndex((r) => r.identifier === identifier && r.token === token)
      if (index === -1) return undefined
      return tokenRows.splice(index, 1)[0]
    },
  }

  const byEmail = new Map<string, string>()
  const accounts: AccountStore = {
    async createOrFindByEmail(email: string) {
      const existing = byEmail.get(email)
      if (existing) return { accountId: existing, created: false }
      const accountId = `acct_${byEmail.size + 1}`
      byEmail.set(email, accountId)
      return { accountId, created: true }
    },
  }
  const users: AuthUserStore = {
    async findByEmail(email: string) {
      const id = byEmail.get(email)
      return id ? { id, email } : undefined
    },
    async findById(id: string) {
      for (const [email, accountId] of byEmail) if (accountId === id) return { id, email }
      return undefined
    },
  }

  const sent: EmailMessage[] = []
  const mail: EmailProvider = {
    async send(message) {
      sent.push(message)
      return { providerMessageId: `mock-${sent.length}` }
    },
  }

  const sessions = memorySessionStore(users)
  const config = buildAuthConfig({
    adapter: buildAuthAdapter({
      tokens,
      users,
      sessions: sessions.store,
      provisioning: { store: accounts },
    }),
    revokeAllSessions: async (accountId) => {
      await sessions.store.removeAllForAccount(accountId)
    },
    email: { sendLink: sendSignInLinkVia(() => mail) },
  })

  const { handlers } = NextAuth({ ...config, logger: { error() {}, warn() {}, debug() {} } })

  const request = (path: string, jar?: Jar, body?: URLSearchParams) => {
    const headers = new Headers()
    if (jar?.header) headers.set('cookie', jar.header)
    if (body) headers.set('content-type', 'application/x-www-form-urlencoded')
    const init: RequestInit = body
      ? { method: 'POST', headers, body: body.toString() }
      : { method: 'GET', headers }
    return new Request(path.startsWith('http') ? path : `${ORIGIN}${path}`, init) as never
  }

  return { sessions, sent, handlers, request, byEmail }
}

type Harness = ReturnType<typeof harness>

async function csrf(h: Harness, jar: Jar): Promise<string> {
  const response = await h.handlers.GET(h.request('/api/auth/csrf', jar))
  jar.absorb(response)
  return ((await response.json()) as { csrfToken: string }).csrfToken
}

/** Signs a fresh browser in by asking for a link and opening it. */
async function signIn(h: Harness, email: string): Promise<Jar> {
  const jar = new Jar()
  const csrfToken = await csrf(h, jar)
  const asked = await h.handlers.POST(
    h.request(
      '/api/auth/signin/email',
      jar,
      new URLSearchParams({ email, csrfToken, callbackUrl: '/dashboard' }),
    ),
  )
  jar.absorb(asked)

  const latest = h.sent[h.sent.length - 1]!
  const link = /(http:\/\/\S+)/.exec(latest.text ?? '')![1]!
  jar.absorb(await h.handlers.GET(h.request(link, jar)))
  return jar
}

async function signedInAs(h: Harness, jar: Jar): Promise<string | undefined> {
  const response = await h.handlers.GET(h.request('/api/auth/session', jar))
  const body = (await response.json()) as { user?: { id?: string } } | null
  return body?.user?.id
}

beforeEach(() => {
  process.env.AUTH_SECRET = 'test-secret-not-used-anywhere-real'
  delete process.env.AUTH_URL
  delete process.env.NEXTAUTH_URL
})

describe('what is stored for a signed-in browser', () => {
  it('is a digest, never the cookie the browser presents', async () => {
    const h = harness()
    const jar = await signIn(h, 'founder@example.com')

    const cookie = jar.value(SESSION_COOKIE)!
    expect(cookie).toBeTruthy()
    // A leaked copy of this table must not be a set of working sessions.
    expect([...h.sessions.rows.keys()]).not.toContain(cookie)
    expect([...h.sessions.rows.keys()]).toEqual([sessionTokenDigest(cookie)])
  })

  it('costs one lookup and nothing else, on every signed-in request', async () => {
    const h = harness()
    const jar = await signIn(h, 'founder@example.com')
    const before = h.sessions.rows.get(sessionTokenDigest(jar.value(SESSION_COOKIE)!))!

    h.sessions.calls.length = 0
    await signedInAs(h, jar)
    await signedInAs(h, jar)

    // This is the price the founder agreed to, and the whole price. A sliding
    // lifetime would have added a write here, on a schedule nobody would notice
    // until the database was busy.
    expect(h.sessions.calls).toEqual(['findWithAccount', 'findWithAccount'])
    const after = h.sessions.rows.get(sessionTokenDigest(jar.value(SESSION_COOKIE)!))!
    expect(after.expires, 'the lapse date is fixed at sign-in and never moved').toEqual(
      before.expires,
    )
  })
})

describe('revoking a session', () => {
  it('stops a copied cookie working, at once', async () => {
    const h = harness()
    const jar = await signIn(h, 'founder@example.com')
    const stolen = jar.copyOfSessionCookie()

    expect(await signedInAs(h, stolen), 'the copy works while the session stands').toBe('acct_1')

    await h.sessions.store.removeAllForAccount('acct_1')

    expect(await signedInAs(h, stolen)).toBeUndefined()
    expect(await signedInAs(h, jar), 'and so does the browser it was copied from').toBeUndefined()
  })

  it('leaves other accounts alone', async () => {
    const h = harness()
    const one = await signIn(h, 'founder@example.com')
    const other = await signIn(h, 'someone@example.com')

    await h.sessions.store.removeAllForAccount('acct_1')

    expect(await signedInAs(h, one)).toBeUndefined()
    expect(await signedInAs(h, other)).toBe('acct_2')
  })
})

describe('signing out', () => {
  it('ends the session in every browser, not only the one that pressed it', async () => {
    const h = harness()
    const laptop = await signIn(h, 'founder@example.com')
    const phone = await signIn(h, 'founder@example.com')
    expect(await signedInAs(h, phone)).toBe('acct_1')

    const csrfToken = await csrf(h, laptop)
    const out = await h.handlers.POST(
      h.request('/api/auth/signout', laptop, new URLSearchParams({ csrfToken })),
    )
    laptop.absorb(out)

    expect(await signedInAs(h, laptop)).toBeUndefined()
    expect(await signedInAs(h, phone), 'the browser that did not press it').toBeUndefined()
    expect(h.sessions.rows.size).toBe(0)
  })

  it('leaves every other account where it was', async () => {
    const h = harness()
    const leaving = await signIn(h, 'founder@example.com')
    const staying = await signIn(h, 'someone@example.com')

    const csrfToken = await csrf(h, leaving)
    leaving.absorb(
      await h.handlers.POST(
        h.request('/api/auth/signout', leaving, new URLSearchParams({ csrfToken })),
      ),
    )

    expect(await signedInAs(h, staying)).toBe('acct_2')
  })
})

describe('asking to have the account deleted', () => {
  it('locks every browser out immediately, a week before the rows are erased', async () => {
    const h = harness()
    const laptop = await signIn(h, 'founder@example.com')
    const phone = await signIn(h, 'founder@example.com')

    const store: AccountLifecycleStore = {
      async load() {
        return {
          accountId: 'acct_1',
          email: 'founder@example.com',
          domainNormalized: null,
          stripeSubscriptionId: null,
          shopifyToken: null,
          googleRefreshToken: null,
          deletedAt: null,
        }
      },
      async markDeleted() {
        return true
      },
      revokeSessions: (accountId) => h.sessions.store.removeAllForAccount(accountId),
      async purgePreviewCache() {},
      async queueClosure() {},
      async clearGrants() {},
    }

    const result = await requestAccountDeletion({ store }, { accountId: 'acct_1' })
    expect(result.kind).toBe('deleted')

    expect(await signedInAs(h, laptop)).toBeUndefined()
    expect(await signedInAs(h, phone)).toBeUndefined()
  })
})

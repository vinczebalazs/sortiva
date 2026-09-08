import { beforeEach, describe, expect, it } from 'vitest'
import NextAuth from 'next-auth'
import type { AccountStore, EmailMessage, EmailProvider, EmailSendResult } from '@sortiva/core'
import { requestEmailSignIn, SIGN_IN_EMAIL_ENDPOINT, SIGN_IN_TOKEN_ENDPOINT } from '@sortiva/ui'
import { buildAuthAdapter, type AuthUserStore, type VerificationTokenStore } from './adapter'
import { buildAuthConfig } from './config'
import { memorySessionStore } from './memorySessions'
import { sendSignInLinkVia } from './signInEmail'

/**
 * Signing in with a link, driven through the real Auth.js handlers rather than
 * around them: a request goes in, an email comes out, the link in it is opened,
 * and the response is inspected for a session. Storage and the mail vendor are
 * in memory; every decision in between is the library's own.
 *
 * That matters because the three things this has to get right are all decided
 * inside the library — that a link opens a session, that opening it twice does
 * not, and that a stale one is refused. Testing our own functions would prove
 * none of them.
 */

const ORIGIN = 'http://localhost:3000'

interface TokenRow {
  identifier: string
  token: string
  expires: Date
}

function memoryTokens() {
  const rows: TokenRow[] = []
  const store: VerificationTokenStore = {
    async create(input) {
      rows.push({ ...input })
    },
    async use({ identifier, token }) {
      const index = rows.findIndex((r) => r.identifier === identifier && r.token === token)
      if (index === -1) return undefined
      return rows.splice(index, 1)[0]
    },
  }
  return { store, rows }
}

function memoryAccounts() {
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
  return { accounts, users, byEmail }
}

function memoryMailbox() {
  const sent: EmailMessage[] = []
  const provider: EmailProvider = {
    async send(message): Promise<EmailSendResult> {
      sent.push(message)
      return { providerMessageId: `mock-${sent.length}` }
    },
  }
  return { sent, provider }
}

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

  has(name: string): boolean {
    return this.values.has(name)
  }
}

function harness() {
  const tokens = memoryTokens()
  const store = memoryAccounts()
  const mailbox = memoryMailbox()

  const provisioning = { store: store.accounts }
  const sessions = memorySessionStore(store.users)
  const config = buildAuthConfig({
    adapter: buildAuthAdapter({
      tokens: tokens.store,
      users: store.users,
      sessions: sessions.store,
      provisioning,
    }),
    revokeAllSessions: async (accountId) => {
      await sessions.store.removeAllForAccount(accountId)
    },
    email: { sendLink: sendSignInLinkVia(() => mailbox.provider) },
  })

  // Three of these cases exist to make the library refuse something, and it
  // logs every refusal. Silencing it keeps a passing run quiet; the assertions,
  // not the log, are what say the refusal happened.
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

  /**
   * A `fetch` that answers from the real sign-in handlers, for one browser's
   * cookies. This is what the sign-in screen is handed in a page; there it is
   * the browser's own `fetch` and the cookies travel by themselves.
   */
  const fetchFor = (jar: Jar): typeof globalThis.fetch =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers((init?.headers ?? {}) as Record<string, string>)
      if (jar.header) headers.set('cookie', jar.header)
      const built = new Request(`${ORIGIN}${String(input)}`, {
        method: init?.method ?? 'GET',
        headers,
        ...(init?.body ? { body: init.body as string } : {}),
      })
      const response =
        built.method === 'POST'
          ? await handlers.POST(built as never)
          : await handlers.GET(built as never)
      jar.absorb(response)
      return response
    }) as unknown as typeof globalThis.fetch

  return { tokens, store, mailbox, sessions, handlers, request, fetchFor }
}

type Harness = ReturnType<typeof harness>

/** Auth.js rejects a sign-in POST without the token it handed out first. */
async function askForLink(h: Harness, email: string): Promise<{ jar: Jar; response: Response }> {
  const jar = new Jar()
  const csrfResponse = await h.handlers.GET(h.request('/api/auth/csrf', jar))
  jar.absorb(csrfResponse)
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string }

  const body = new URLSearchParams({ email, csrfToken, callbackUrl: '/plan' })
  const response = await h.handlers.POST(h.request('/api/auth/signin/email', jar, body))
  jar.absorb(response)
  return { jar, response }
}

/** The link out of the most recent email. Read from the plain-text part, unescaped. */
function linkFrom(message: EmailMessage): string {
  const match = /(http:\/\/\S+)/.exec(message.text ?? '')
  if (!match) throw new Error(`no link in email: ${message.text}`)
  return match[1]!
}

beforeEach(() => {
  process.env.AUTH_SECRET = 'test-secret-not-used-anywhere-real'
  delete process.env.AUTH_URL
  delete process.env.NEXTAUTH_URL
})

describe('signing in with a link (main §4.1)', () => {
  it('emails a link, and opening it signs a new merchant in to one account', async () => {
    const h = harness()

    const { jar } = await askForLink(h, 'founder@example.com')

    expect(h.mailbox.sent).toHaveLength(1)
    expect(h.mailbox.sent[0]!.to).toBe('founder@example.com')

    const opened = await h.handlers.GET(h.request(linkFrom(h.mailbox.sent[0]!), jar))
    jar.absorb(opened)
    expect(opened.status).toBe(302)
    expect(opened.headers.get('location')).toBe(`${ORIGIN}/plan`)

    const session = await h.handlers.GET(h.request('/api/auth/session', jar))
    const body = (await session.json()) as { user?: { id?: string } }
    expect(body.user?.id).toBe('acct_1')

    // Exactly one account, and it is the one the session names.
    expect([...h.store.byEmail]).toEqual([['founder@example.com', 'acct_1']])
  })

  it('spends the link: opening the same one twice does not sign in again', async () => {
    const h = harness()
    const { jar } = await askForLink(h, 'founder@example.com')
    const link = linkFrom(h.mailbox.sent[0]!)

    const first = await h.handlers.GET(h.request(link, jar))
    expect(first.headers.get('location')).toBe(`${ORIGIN}/plan`)

    // A second opening — a forwarded email, or a mail scanner following the URL.
    const second = await h.handlers.GET(h.request(link, new Jar()))
    expect(second.status).toBe(302)
    expect(second.headers.get('location')).toContain('/api/auth/error?error=Verification')

    const rejected = new Jar()
    rejected.absorb(second)
    expect(rejected.has('authjs.session-token')).toBe(false)
  })

  it('refuses a link that has expired', async () => {
    const h = harness()
    const { jar } = await askForLink(h, 'founder@example.com')

    // The link ages in the mailbox: same secret, and the row it was issued
    // against is now past its expiry.
    h.tokens.rows[0]!.expires = new Date(Date.now() - 1000)

    const opened = await h.handlers.GET(h.request(linkFrom(h.mailbox.sent[0]!), jar))
    expect(opened.status).toBe(302)
    expect(opened.headers.get('location')).toContain('/api/auth/error?error=Verification')

    const after = new Jar()
    after.absorb(opened)
    expect(after.has('authjs.session-token')).toBe(false)
    expect([...h.store.byEmail]).toHaveLength(0)
  })

  it('refuses a made-up link', async () => {
    const h = harness()
    await askForLink(h, 'founder@example.com')

    const forged = `${ORIGIN}/api/auth/callback/email?${new URLSearchParams({
      callbackUrl: '/plan',
      token: 'not-a-real-token',
      email: 'founder@example.com',
    })}`

    const opened = await h.handlers.GET(h.request(forged, new Jar()))
    expect(opened.headers.get('location')).toContain('/api/auth/error?error=Verification')
    expect([...h.store.byEmail]).toHaveLength(0)
  })

  it('sends a link to an address with no account without creating one', async () => {
    const h = harness()
    await askForLink(h, 'stranger@example.com')

    expect(h.mailbox.sent).toHaveLength(1)
    // The account appears when the link is opened, not when it is requested —
    // otherwise anyone could fill the table by typing addresses.
    expect([...h.store.byEmail]).toHaveLength(0)
  })

  it('signs a returning merchant back in to the same account', async () => {
    const h = harness()

    const first = await askForLink(h, 'founder@example.com')
    await h.handlers.GET(h.request(linkFrom(h.mailbox.sent[0]!), first.jar))

    const second = await askForLink(h, 'founder@example.com')
    const jar = second.jar
    const opened = await h.handlers.GET(h.request(linkFrom(h.mailbox.sent[1]!), jar))
    jar.absorb(opened)

    const session = await h.handlers.GET(h.request('/api/auth/session', jar))
    const body = (await session.json()) as { user?: { id?: string } }
    expect(body.user?.id).toBe('acct_1')
    expect([...h.store.byEmail]).toHaveLength(1)
  })

  // The sign-in library's own fallback page, which is not the screen a merchant
  // sees — that is `/signin`, and it is checked where it is rendered. This is
  // here because the page is generated from the provider list, so it is a
  // second reading of what the configuration offers.
  it('the library’s own fallback page lists both providers', async () => {
    const h = harness()
    const page = await h.handlers.GET(h.request('/api/auth/signin', new Jar()))
    const html = await page.text()

    expect(html).toContain('/api/auth/signin/email')
    expect(html).toContain('/api/auth/signin/google')
  })
})

/**
 * **The sign-in screen's email field, wired to the real sign-in library.**
 *
 * The block above proves the link flow works when something asks for a link.
 * This proves the thing that asks is the screen: it runs
 * `requestEmailSignIn` — the shared component package's own function, the whole
 * body of the button's click handler — against the real handlers built from the
 * real configuration. Nothing on the answering side is stubbed except storage
 * and the mailbox.
 *
 * **Assertions are on the destination, never the status**, for the reason the
 * last case here records: the library answers a refused send with `200`.
 *
 * The one link a test in this repository cannot drive is React dispatching the
 * click, because there is no browser-DOM test environment here. That the field
 * and the button are on the screen at all is held in `public.test.ts`, where
 * the component is rendered.
 */
describe('pressing “Email me a sign-in link” on the sign-in screen', () => {
  it('sends the link, and opening it signs the merchant in', async () => {
    const h = harness()
    const jar = new Jar()

    const outcome = await requestEmailSignIn({
      fetch: h.fetchFor(jar),
      email: 'founder@example.com',
    })

    expect(outcome).toEqual({ kind: 'link_sent' })
    expect(h.mailbox.sent.map((m) => m.to)).toEqual(['founder@example.com'])

    const opened = await h.handlers.GET(h.request(linkFrom(h.mailbox.sent[0]!), jar))
    jar.absorb(opened)
    expect(opened.headers.get('location')).toBe(`${ORIGIN}/plan`)

    const session = await h.handlers.GET(h.request('/api/auth/session', jar))
    expect(((await session.json()) as { user?: { id?: string } }).user?.id).toBe('acct_1')
  })

  it('keeps the place the visitor asked to land', async () => {
    const h = harness()
    const jar = new Jar()

    await requestEmailSignIn({
      fetch: h.fetchFor(jar),
      email: 'founder@example.com',
      callbackUrl: '/settings/publishing',
    })

    // Carried in the link itself rather than a cookie, because the visitor may
    // open the link in a different browser from the one that asked for it.
    const link = new URL(linkFrom(h.mailbox.sent[0]!))
    expect(link.searchParams.get('callbackUrl')).toBe(`${ORIGIN}/settings/publishing`)

    const opened = await h.handlers.GET(h.request(link.toString(), jar))
    expect(opened.headers.get('location')).toBe(`${ORIGIN}/settings/publishing`)
  })

  it('reports a failure, and sends nothing, when the address is not one', async () => {
    const h = harness()

    const outcome = await requestEmailSignIn({
      fetch: h.fetchFor(new Jar()),
      email: 'founder-at-example',
    })

    expect(outcome).toEqual({ kind: 'failed' })
    expect(h.mailbox.sent).toHaveLength(0)
  })

  it('reports a failure when the anti-forgery token is refused', async () => {
    const h = harness()
    const jar = new Jar()
    const real = h.fetchFor(jar)

    // The library refuses a send whose token does not match the cookie it
    // issued. A press that ends here has to be reported as a failure, or the
    // screen tells a merchant to go and look for an email that was never sent.
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

    expect(await requestEmailSignIn({ fetch: tampered, email: 'founder@example.com' })).toEqual({
      kind: 'failed',
    })
    expect(h.mailbox.sent).toHaveLength(0)
  })

  it('records that a refused send answers 200, so no test here may trust one', async () => {
    const h = harness()
    const jar = new Jar()
    const fetch = h.fetchFor(jar)

    const csrf = await fetch(SIGN_IN_TOKEN_ENDPOINT, {
      method: 'GET',
      headers: { accept: 'application/json' },
    })
    const { csrfToken } = (await csrf.json()) as { csrfToken: string }

    const refused = await fetch(SIGN_IN_EMAIL_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'X-Auth-Return-Redirect': '1',
      },
      body: new URLSearchParams({ csrfToken, callbackUrl: '/plan', email: 'not-an-address' }),
    })

    expect(refused.status, 'a refused send is not an error status').toBe(200)
    expect(refused.ok, 'and `ok` is true, which is what makes reading it by hand necessary').toBe(
      true,
    )

    // The whole tell is here: the library names its own error screen. Nothing
    // was posted, and the exchange has to read this as the failure it is.
    const { url } = (await refused.json()) as { url: string }
    expect(new URL(url).pathname).toBe('/api/auth/error')
    expect(h.mailbox.sent).toHaveLength(0)
  })
})

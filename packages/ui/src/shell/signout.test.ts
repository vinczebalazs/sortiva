import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AccountMenu } from './AccountMenu'
import {
  AFTER_SIGN_OUT,
  requestSignOut,
  SIGN_OUT_ENDPOINT,
  SIGN_OUT_TOKEN_ENDPOINT,
} from './signout'
import { t } from '../strings'

/**
 * The control that signs a merchant out, and the exchange behind it.
 *
 * Signing out here ends every session the account has, in every browser — the
 * whole point of the control — and that is proved end to end against the real
 * sign-in library in `apps/web/app/(app)/_lib/signout-wire.test.ts`. What is
 * held here is the half that lives in this package: that the button exists,
 * says what it will do before it does it, and sends the two requests the
 * library requires.
 */

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(element)

interface Call {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string | undefined
}

function recordingFetch(
  answer: (call: Call) => Response,
): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[name.toLowerCase()] = value
    }
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    calls.push(call)
    return answer(call)
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function happyPath() {
  return recordingFetch((call) =>
    call.url === SIGN_OUT_TOKEN_ENDPOINT
      ? json({ csrfToken: 'token-from-the-library' })
      : json({ url: 'http://localhost:3000/' }),
  )
}

describe('the sign-out exchange', () => {
  it('spends the token the library hands out, on the library’s own address', async () => {
    const { fetch, calls } = happyPath()

    const outcome = await requestSignOut({ fetch })

    expect(outcome.kind).toBe('signed_out')
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${SIGN_OUT_TOKEN_ENDPOINT}`,
      `POST ${SIGN_OUT_ENDPOINT}`,
    ])
    const sent = new URLSearchParams(calls[1]!.body)
    expect(sent.get('csrfToken')).toBe('token-from-the-library')
    expect(sent.get('callbackUrl')).toBe(AFTER_SIGN_OUT)
  })

  it('carries the session cookie, or it would sign nobody out', async () => {
    const { fetch } = happyPath()
    let credentials: unknown
    const watched = (async (input: RequestInfo | URL, init?: RequestInit) => {
      credentials = init?.credentials
      return fetch(input, init)
    }) as unknown as typeof globalThis.fetch

    await requestSignOut({ fetch: watched })

    expect(credentials).toBe('same-origin')
  })

  it('asks for an answer rather than a redirect to the whole landing page', async () => {
    const { fetch, calls } = happyPath()

    await requestSignOut({ fetch })

    expect(calls[1]!.headers['x-auth-return-redirect']).toBe('1')
  })

  it('follows the library’s answer for where to land', async () => {
    const { fetch } = recordingFetch((call) =>
      call.url === SIGN_OUT_TOKEN_ENDPOINT
        ? json({ csrfToken: 'a-token' })
        : json({ url: 'http://localhost:3000/goodbye' }),
    )

    expect(await requestSignOut({ fetch })).toEqual({
      kind: 'signed_out',
      url: 'http://localhost:3000/goodbye',
    })
  })

  it('reports a failure rather than pretending, when the token cannot be had', async () => {
    const { fetch, calls } = recordingFetch(() => json({ error: 'nope' }, 500))

    expect(await requestSignOut({ fetch })).toEqual({ kind: 'failed' })
    // Nothing is posted on a token it does not have.
    expect(calls).toHaveLength(1)
  })

  it('reports a failure when the library refuses the sign-out', async () => {
    const { fetch } = recordingFetch((call) =>
      call.url === SIGN_OUT_TOKEN_ENDPOINT ? json({ csrfToken: 'a-token' }) : json({}, 403),
    )

    expect(await requestSignOut({ fetch })).toEqual({ kind: 'failed' })
  })

  it('reports a failure when the library answers 200 with its own error page', async () => {
    // Auth.js does not use an error status for a refused sign-out: it answers
    // 200 and names its error page as where to go. Trusting the status here
    // would tell a merchant they were signed out everywhere while nothing was.
    const { fetch } = recordingFetch((call) =>
      call.url === SIGN_OUT_TOKEN_ENDPOINT
        ? json({ csrfToken: 'a-token' })
        : json({ url: 'http://localhost:3000/api/auth/error?error=MissingCSRF' }),
    )

    expect(await requestSignOut({ fetch })).toEqual({ kind: 'failed' })
  })

  it('reports a failure when the network never answers', async () => {
    const fetch = (async () => {
      throw new Error('offline')
    }) as unknown as typeof globalThis.fetch

    expect(await requestSignOut({ fetch })).toEqual({ kind: 'failed' })
  })
})

describe('the account menu', () => {
  const html = () => render(createElement(AccountMenu, {}))

  it('offers a sign-out', () => {
    expect(html()).toContain('data-testid="sign-out"')
    expect(html()).toContain(t('shell.accountMenu.signOut'))
  })

  it('says it reaches every browser before the button is pressed', () => {
    // Not a toast afterwards: a merchant signing out on a phone is about to
    // sign their desktop out too, and would otherwise find out by accident.
    expect(html()).toContain(t('shell.accountMenu.signOutEverywhere'))
  })

  it('opens and closes without any JavaScript', () => {
    expect(html()).toContain('<details')
    expect(html()).toContain('<summary')
  })

  it('takes every word it renders from the string catalogue', () => {
    const rendered = html()
    for (const key of [
      'shell.account',
      'shell.accountMenu.signOut',
      'shell.accountMenu.signOutEverywhere',
    ] as const) {
      expect(rendered).toContain(t(key))
    }
  })
})

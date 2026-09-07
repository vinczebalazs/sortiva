import { describe, expect, it } from 'vitest'
import {
  AFTER_SIGN_IN,
  requestGoogleSignIn,
  SIGN_IN_GOOGLE_ENDPOINT,
  SIGN_IN_TOKEN_ENDPOINT,
} from './signin-exchange'

/**
 * The exchange behind "Continue with Google".
 *
 * What is held here is the half that lives in this package: that the press
 * sends the two requests the sign-in library requires, and that it reads the
 * answer by where the library says to go rather than by the status. That it
 * actually reaches Google is proved end to end against the real sign-in
 * handlers in `apps/web/app/(public)/_lib/signin-wire.test.ts`.
 */

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

const GOOGLE = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x'

function happyPath() {
  return recordingFetch((call) =>
    call.url === SIGN_IN_TOKEN_ENDPOINT
      ? json({ csrfToken: 'token-from-the-library' })
      : json({ url: GOOGLE }),
  )
}

describe('the sign-in exchange', () => {
  it('spends the token the library hands out, on the library’s own address', async () => {
    const { fetch, calls } = happyPath()

    const outcome = await requestGoogleSignIn({ fetch })

    expect(outcome).toEqual({ kind: 'handshake_started', url: GOOGLE })
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${SIGN_IN_TOKEN_ENDPOINT}`,
      `POST ${SIGN_IN_GOOGLE_ENDPOINT}`,
    ])
    const sent = new URLSearchParams(calls[1]!.body)
    expect(sent.get('csrfToken')).toBe('token-from-the-library')
    expect(sent.get('callbackUrl')).toBe(AFTER_SIGN_IN)
  })

  it('carries the cookie the token was issued against, or the library refuses it', async () => {
    const { fetch } = happyPath()
    const seen: unknown[] = []
    const watched = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.credentials)
      return fetch(input, init)
    }) as unknown as typeof globalThis.fetch

    await requestGoogleSignIn({ fetch: watched })

    expect(seen).toEqual(['same-origin', 'same-origin'])
  })

  it('asks for an answer rather than a redirect out to Google’s consent page', async () => {
    const { fetch, calls } = happyPath()

    await requestGoogleSignIn({ fetch })

    expect(calls[1]!.headers['x-auth-return-redirect']).toBe('1')
  })

  it('sends the visitor on to where they asked to land afterwards', async () => {
    const { fetch, calls } = happyPath()

    await requestGoogleSignIn({ fetch, callbackUrl: '/settings/publishing' })

    expect(new URLSearchParams(calls[1]!.body).get('callbackUrl')).toBe('/settings/publishing')
  })

  it('reports a failure rather than pretending, when the token cannot be had', async () => {
    const { fetch, calls } = recordingFetch(() => json({ error: 'nope' }, 500))

    expect(await requestGoogleSignIn({ fetch })).toEqual({ kind: 'failed' })
    // Nothing is posted on a token it does not have.
    expect(calls).toHaveLength(1)
  })

  it('reports a failure when the library answers 200 with its own error page', async () => {
    // This is the shape of the defect this replaced: Auth.js does not use an
    // error status for a refused sign-in. It answers 200 and names its own
    // screen as where to go, so trusting the status would march the visitor
    // onto a page saying sign-in failed while reporting that it worked.
    const { fetch } = recordingFetch((call) =>
      call.url === SIGN_IN_TOKEN_ENDPOINT
        ? json({ csrfToken: 'a-token' })
        : json({ url: 'http://localhost:3000/api/auth/signin?error=MissingCSRF' }),
    )

    expect(await requestGoogleSignIn({ fetch })).toEqual({ kind: 'failed' })
  })

  it('reports a failure when the library names nowhere to go', async () => {
    const { fetch } = recordingFetch((call) =>
      call.url === SIGN_IN_TOKEN_ENDPOINT ? json({ csrfToken: 'a-token' }) : json({}),
    )

    expect(await requestGoogleSignIn({ fetch })).toEqual({ kind: 'failed' })
  })

  it('reports a failure when the network never answers', async () => {
    const fetch = (async () => {
      throw new Error('offline')
    }) as unknown as typeof globalThis.fetch

    expect(await requestGoogleSignIn({ fetch })).toEqual({ kind: 'failed' })
  })
})

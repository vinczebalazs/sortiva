/**
 * What pressing "Sign out" actually sends.
 *
 * The sign-in library owns the two addresses below and defines their shapes, so
 * nothing here decides anything about them — it decides only that this is the
 * exchange the button performs, and it lives apart from the component so the
 * exchange can be driven against the real sign-in handlers without a browser.
 *
 * Two requests rather than one because the library refuses a sign-out that does
 * not carry the anti-forgery token it hands out: the first request asks for the
 * token, the second spends it. Written here rather than reached for from the
 * sign-in library's own browser helper, which needs a `window` and a global
 * `fetch` to exist before it can be called at all — and which would put a
 * server-side dependency inside the shared component package for the sake of
 * fifteen lines.
 */

/** Where the anti-forgery token comes from. The sign-in library's own address. */
export const SIGN_OUT_TOKEN_ENDPOINT = '/api/auth/csrf'

/** Where signing out is actually done. The sign-in library's own address. */
export const SIGN_OUT_ENDPOINT = '/api/auth/signout'

/** Where a signed-out merchant lands. The public landing page, not the sign-in screen. */
export const AFTER_SIGN_OUT = '/'

/**
 * Asks the library to answer in JSON rather than with a redirect. Without it a
 * sign-out from a script downloads the whole landing page as the reply to a
 * button press, and there is no way to tell a refused sign-out from a
 * successful one that happened to redirect somewhere.
 */
const RETURN_REDIRECT_HEADER = 'X-Auth-Return-Redirect'

export type SignOutOutcome =
  /** Every session the account had is gone; `url` is where to go next. */
  | { readonly kind: 'signed_out'; readonly url: string }
  /** Nothing was ended. The merchant is still signed in and is told so. */
  | { readonly kind: 'failed' }

export interface SignOutDeps {
  /** Injected so the exchange can be pointed at real handlers in a test. */
  readonly fetch: typeof globalThis.fetch
  readonly tokenEndpoint?: string
  readonly signOutEndpoint?: string
  readonly redirectTo?: string
}

export async function requestSignOut({
  fetch,
  tokenEndpoint = SIGN_OUT_TOKEN_ENDPOINT,
  signOutEndpoint = SIGN_OUT_ENDPOINT,
  redirectTo = AFTER_SIGN_OUT,
}: SignOutDeps): Promise<SignOutOutcome> {
  let csrfToken: unknown
  try {
    const asked = await fetch(tokenEndpoint, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
    if (!asked.ok) return { kind: 'failed' }
    ;({ csrfToken } = (await asked.json()) as { csrfToken?: unknown })
  } catch {
    return { kind: 'failed' }
  }
  if (typeof csrfToken !== 'string' || csrfToken.length === 0) return { kind: 'failed' }

  try {
    const response = await fetch(signOutEndpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        [RETURN_REDIRECT_HEADER]: '1',
      },
      body: new URLSearchParams({ csrfToken, callbackUrl: redirectTo }).toString(),
    })
    if (!response.ok) return { kind: 'failed' }
    const body = (await response.json()) as { url?: unknown }
    const url = typeof body.url === 'string' && body.url.length > 0 ? body.url : redirectTo
    // A refused sign-out is not an error status. The library answers 200 and
    // names its own error page as where to go next — so a caller that trusted
    // the status would tell the merchant they were signed out of everywhere
    // while every session stood. A sign-out that worked never lands back
    // inside the sign-in routes.
    if (isWithin(url, signOutEndpoint)) return { kind: 'failed' }
    return { kind: 'signed_out', url }
  } catch {
    return { kind: 'failed' }
  }
}

/** Whether a destination sits under the sign-in library's own routes. */
function isWithin(url: string, signOutEndpoint: string): boolean {
  const base = signOutEndpoint.slice(0, signOutEndpoint.lastIndexOf('/') + 1)
  try {
    return new URL(url, 'http://sortiva.invalid').pathname.startsWith(base)
  } catch {
    return false
  }
}

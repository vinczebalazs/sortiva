/**
 * What pressing "Continue with Google" actually sends.
 *
 * The sign-in library owns the two addresses below and defines their shapes, so
 * nothing here decides anything about them — it decides only that this is the
 * exchange the button performs, and it lives apart from the component so the
 * exchange can be driven against the real sign-in handlers without a browser.
 *
 * Two requests rather than one because the library refuses a sign-in that does
 * not carry the anti-forgery token it hands out: the first request asks for the
 * token, the second spends it. This is the same shape signing out uses, for the
 * same reason; the two are kept apart because they are different exchanges with
 * different answers, not because either could be written another way.
 *
 * A successful press does not sign anybody in. It starts a handshake: the
 * library answers with the identity provider's address, and the browser leaves
 * for it. Whether an account exists is settled later, when the provider sends
 * the browser back.
 */

/** Where the anti-forgery token comes from. The sign-in library's own address. */
export const SIGN_IN_TOKEN_ENDPOINT = '/api/auth/csrf'

/** Where the Google handshake is started. The sign-in library's own address. */
export const SIGN_IN_GOOGLE_ENDPOINT = '/api/auth/signin/google'

/** Where a merchant lands once the provider has sent them back. */
export const AFTER_SIGN_IN = '/plan'

/**
 * Asks the library to answer in JSON rather than with a redirect. Without it a
 * sign-in started from a script downloads Google's consent page as the reply to
 * a button press, and there is no way to tell a refused start from one that
 * worked.
 */
const RETURN_REDIRECT_HEADER = 'X-Auth-Return-Redirect'

export type SignInOutcome =
  /** The handshake is under way; `url` is the identity provider's address. */
  | { readonly kind: 'handshake_started'; readonly url: string }
  /** Nothing started. The merchant is still signed out and is told so. */
  | { readonly kind: 'failed' }

export interface SignInDeps {
  /** Injected so the exchange can be pointed at real handlers in a test. */
  readonly fetch: typeof globalThis.fetch
  readonly tokenEndpoint?: string
  readonly signInEndpoint?: string
  /** Where the merchant should land once the provider sends them back. */
  readonly callbackUrl?: string
}

export async function requestGoogleSignIn({
  fetch,
  tokenEndpoint = SIGN_IN_TOKEN_ENDPOINT,
  signInEndpoint = SIGN_IN_GOOGLE_ENDPOINT,
  callbackUrl = AFTER_SIGN_IN,
}: SignInDeps): Promise<SignInOutcome> {
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
    const response = await fetch(signInEndpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        [RETURN_REDIRECT_HEADER]: '1',
      },
      body: new URLSearchParams({ csrfToken, callbackUrl }).toString(),
    })
    if (!response.ok) return { kind: 'failed' }
    const body = (await response.json()) as { url?: unknown }
    if (typeof body.url !== 'string' || body.url.length === 0) return { kind: 'failed' }
    // A refused sign-in is not an error status. The library answers 200 and
    // names its own error page as where to go next — so a caller that trusted
    // the status would send the merchant to a page saying sign-in failed while
    // reporting that it worked. A start that worked always leaves for the
    // identity provider, so a destination still inside our own sign-in routes
    // means it did not.
    if (isWithin(body.url, tokenEndpoint)) return { kind: 'failed' }
    return { kind: 'handshake_started', url: body.url }
  } catch {
    return { kind: 'failed' }
  }
}

/** Whether a destination sits under the sign-in library's own routes. */
function isWithin(url: string, tokenEndpoint: string): boolean {
  const base = tokenEndpoint.slice(0, tokenEndpoint.lastIndexOf('/') + 1)
  try {
    return new URL(url, 'http://sortiva.invalid').pathname.startsWith(base)
  } catch {
    return false
  }
}

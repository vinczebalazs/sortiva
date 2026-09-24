/**
 * What the two sign-in buttons actually send.
 *
 * The sign-in library owns the addresses below and defines their shapes, so
 * nothing here decides anything about them — it decides only that these are the
 * exchanges the buttons perform, and they live apart from the component so they
 * can be driven against the real sign-in handlers without a browser.
 *
 * Two requests rather than one because the library refuses a sign-in that does
 * not carry the anti-forgery token it hands out: the first request asks for the
 * token, the second spends it. This is the same shape signing out uses, for the
 * same reason; the exchanges are kept apart because they are different
 * exchanges with different answers, not because either could be written another
 * way.
 *
 * Neither press signs anybody in. Google's starts a handshake: the library
 * answers with the identity provider's address and the browser leaves for it.
 * The email one posts a link to a mailbox and the visitor stays put; signing in
 * happens when they open the link, which is a plain page load with no script of
 * ours involved. Whether an account exists is settled at that point, not here.
 */

/** Where the anti-forgery token comes from. The sign-in library's own address. */
export const SIGN_IN_TOKEN_ENDPOINT = '/api/auth/csrf'

/** Where the Google handshake is started. The sign-in library's own address. */
export const SIGN_IN_GOOGLE_ENDPOINT = '/api/auth/signin/google'

/** Where a sign-in link is asked for. The sign-in library's own address. */
export const SIGN_IN_EMAIL_ENDPOINT = '/api/auth/signin/email'

/**
 * Where a merchant lands once the provider has sent them back.
 *
 * The dashboard, because there is nowhere else to send them: signing in used to
 * land on a plan screen with a Subscribe button, and there is no purchase to
 * make. The dashboard reads the account and shows whatever state it is actually
 * in — connect your store, still ingesting, or the real thing.
 */
export const AFTER_SIGN_IN = '/dashboard'

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

/**
 * The first of the two requests, shared by both presses. Answers `null` when
 * the library will not hand a token out, which is a sign-in that cannot start.
 */
async function askForToken(
  fetch: typeof globalThis.fetch,
  tokenEndpoint: string,
): Promise<string | null> {
  try {
    const asked = await fetch(tokenEndpoint, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
    if (!asked.ok) return null
    const { csrfToken } = (await asked.json()) as { csrfToken?: unknown }
    return typeof csrfToken === 'string' && csrfToken.length > 0 ? csrfToken : null
  } catch {
    return null
  }
}

export async function requestGoogleSignIn({
  fetch,
  tokenEndpoint = SIGN_IN_TOKEN_ENDPOINT,
  signInEndpoint = SIGN_IN_GOOGLE_ENDPOINT,
  callbackUrl = AFTER_SIGN_IN,
}: SignInDeps): Promise<SignInOutcome> {
  const csrfToken = await askForToken(fetch, tokenEndpoint)
  if (csrfToken === null) return { kind: 'failed' }

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

export type EmailSignInOutcome =
  /** The link is on its way. Nobody is signed in until they open it. */
  | { readonly kind: 'link_sent' }
  /** Nothing was sent. The merchant is still signed out and is told so. */
  | { readonly kind: 'failed' }

export interface EmailSignInDeps extends SignInDeps {
  /** The address the link goes to. Typed by the visitor, sent as typed. */
  readonly email: string
}

/**
 * Asks the library to email a sign-in link.
 *
 * **Reading the answer is the opposite of Google's, and getting it backwards
 * would report every send as a failure.** A Google press that worked leaves our
 * site, so a destination still inside our own sign-in routes means it did not.
 * An email press that worked never leaves: the library names its own
 * "check your mail" page. So success here is one specific page of ours, not the
 * absence of one — and everything else, the error page included, is a failure.
 *
 * The status is again no help: a refused send answers `200` naming the error
 * page, exactly as a refused Google press does.
 */
export async function requestEmailSignIn({
  fetch,
  email,
  tokenEndpoint = SIGN_IN_TOKEN_ENDPOINT,
  signInEndpoint = SIGN_IN_EMAIL_ENDPOINT,
  callbackUrl = AFTER_SIGN_IN,
}: EmailSignInDeps): Promise<EmailSignInOutcome> {
  const csrfToken = await askForToken(fetch, tokenEndpoint)
  if (csrfToken === null) return { kind: 'failed' }

  try {
    const response = await fetch(signInEndpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        [RETURN_REDIRECT_HEADER]: '1',
      },
      body: new URLSearchParams({ csrfToken, callbackUrl, email }).toString(),
    })
    if (!response.ok) return { kind: 'failed' }
    const body = (await response.json()) as { url?: unknown }
    if (typeof body.url !== 'string' || body.url.length === 0) return { kind: 'failed' }
    return isLinkSentPage(body.url, tokenEndpoint) ? { kind: 'link_sent' } : { kind: 'failed' }
  } catch {
    return { kind: 'failed' }
  }
}

/**
 * The one destination that means the link went out. Derived from the token
 * address so both stay together if the library is ever mounted elsewhere.
 */
function isLinkSentPage(url: string, tokenEndpoint: string): boolean {
  const base = tokenEndpoint.slice(0, tokenEndpoint.lastIndexOf('/') + 1)
  try {
    return new URL(url, 'http://sortiva.invalid').pathname === `${base}verify-request`
  } catch {
    return false
  }
}

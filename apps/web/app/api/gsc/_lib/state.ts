import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The value Google hands back to us at the end of the consent flow, and the one
 * thing standing between a merchant and having somebody else's Search Console
 * property attached to their store.
 *
 * It carries the account that started the flow, where to send the merchant when
 * it ends, and a deadline, signed with the app's own secret. At the callback we
 * check the signature, check it has not expired, and check the account inside it
 * is the account whose session is making the request. Without that last check, a
 * link an attacker prepared could finish *their* consent flow inside *your*
 * account — which is how a merchant ends up looking at a stranger's search data
 * and believing it is their own.
 *
 * **The destination is one of two names, never a path.** A signed path would be
 * safe while the signature held and catastrophic the day it did not; a name that
 * the callback itself turns into a path cannot be anything but one of the two
 * screens, whatever anybody manages to forge. It is in the signed payload rather
 * than the query string so it cannot be swapped between the consent screen and
 * the return.
 *
 * Signed rather than stored: it lives for ten minutes and dies at the callback,
 * so a table for it would be a table of rows nobody ever reads twice.
 */

/**
 * Where a merchant goes when the flow ends. Both screens mount the property
 * picker; main §6.7 says connecting from either triggers the same import.
 */
export const OAUTH_RETURNS = ['dashboard', 'connections'] as const
export type OAuthReturn = (typeof OAUTH_RETURNS)[number]

export function isOAuthReturn(value: unknown): value is OAuthReturn {
  return typeof value === 'string' && (OAUTH_RETURNS as readonly string[]).includes(value)
}

// v2 carries the return destination. A v1 state still in flight when this ships
// fails verification and the merchant is asked to connect again — they live ten
// minutes, so the window is one consent screen left open over a deploy.
const VERSION = 'v2'
const TTL_MS = 10 * 60 * 1000

export class OAuthStateInvalid extends Error {
  constructor(readonly reason: string) {
    super(`the Search Console connection could not be verified: ${reason}`)
    this.name = 'OAuthStateInvalid'
  }
}

function secret(): string {
  const value = process.env.AUTH_SECRET
  if (!value) {
    throw new OAuthStateInvalid('AUTH_SECRET is not set, so the connection cannot be signed')
  }
  return value
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url')
}

export function createOAuthState(
  accountId: string,
  returnTo: OAuthReturn,
  now: Date = new Date(),
): string {
  const payload = `${VERSION}.${accountId}.${returnTo}.${now.getTime() + TTL_MS}`
  return `${payload}.${sign(payload)}`
}

/**
 * Throws rather than returning false: every failure here ends the flow, and the
 * reason belongs in the log. Returns where the merchant should land.
 */
export function verifyOAuthState(
  state: string,
  accountId: string,
  now: Date = new Date(),
): OAuthReturn {
  const parts = state.split('.')
  if (parts.length !== 5 || parts[0] !== VERSION) throw new OAuthStateInvalid('malformed')

  const [version, stateAccountId, returnTo, expiry, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
  ]
  const expected = sign(`${version}.${stateAccountId}.${returnTo}.${expiry}`)

  const given = Buffer.from(signature)
  const want = Buffer.from(expected)
  // Comparing with `===` leaks the signature's prefix through timing.
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    throw new OAuthStateInvalid('signature')
  }

  if (Number(expiry) < now.getTime()) throw new OAuthStateInvalid('expired')

  // The flow must finish in the account it started in.
  if (stateAccountId !== accountId) throw new OAuthStateInvalid('account mismatch')

  // Checked after the signature, so this can only reject a state we signed
  // ourselves with a name that has since been removed — never widen it.
  if (!isOAuthReturn(returnTo)) throw new OAuthStateInvalid('unknown destination')

  return returnTo
}

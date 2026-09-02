import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The value Google hands back to us at the end of the consent flow, and the one
 * thing standing between a merchant and having somebody else's Search Console
 * property attached to their store.
 *
 * It carries the account that started the flow and a deadline, signed with the
 * app's own secret. At the callback we check the signature, check it has not
 * expired, and check the account inside it is the account whose session is
 * making the request. Without that last check, a link an attacker prepared could
 * finish *their* consent flow inside *your* account — which is how a merchant
 * ends up looking at a stranger's search data and believing it is their own.
 *
 * Signed rather than stored: it lives for ten minutes and dies at the callback,
 * so a table for it would be a table of rows nobody ever reads twice.
 */

const VERSION = 'v1'
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

export function createOAuthState(accountId: string, now: Date = new Date()): string {
  const payload = `${VERSION}.${accountId}.${now.getTime() + TTL_MS}`
  return `${payload}.${sign(payload)}`
}

/** Throws rather than returning false: every failure here ends the flow, and the reason belongs in the log. */
export function verifyOAuthState(state: string, accountId: string, now: Date = new Date()): void {
  const parts = state.split('.')
  if (parts.length !== 4 || parts[0] !== VERSION) throw new OAuthStateInvalid('malformed')

  const [version, stateAccountId, expiry, signature] = parts as [string, string, string, string]
  const expected = sign(`${version}.${stateAccountId}.${expiry}`)

  const given = Buffer.from(signature)
  const want = Buffer.from(expected)
  // Comparing with `===` leaks the signature's prefix through timing.
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    throw new OAuthStateInvalid('signature')
  }

  if (Number(expiry) < now.getTime()) throw new OAuthStateInvalid('expired')

  // The flow must finish in the account it started in.
  if (stateAccountId !== accountId) throw new OAuthStateInvalid('account mismatch')
}

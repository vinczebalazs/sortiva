import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The `state` value we send to Shopify and get back.
 *
 * It exists to answer one question when the merchant's browser returns: is this
 * the same person, in the same session, finishing the handshake *we* started?
 * Without it, anyone could send a signed-in merchant a link that completes an
 * install against a store the merchant has never heard of.
 *
 * It carries the account and the store it was issued for, signed with the app
 * secret and stamped with a moment, so nothing has to be stored between the two
 * requests. Being unforgeable is what makes it safe to be stateless; the
 * account inside it is checked against the session on the way back, so a state
 * lifted from someone else's browser is useless in yours.
 */

/**
 * How long a half-finished install stays valid. Long enough to read the consent
 * screen and think about it; short enough that a link left in a chat window
 * stops working.
 */
const STATE_TTL_MS = 15 * 60 * 1000

export interface OauthState {
  readonly accountId: string
  readonly shop: string
  readonly issuedAt: number
}

export function signOauthState(state: OauthState, secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({ a: state.accountId, s: state.shop, t: state.issuedAt }),
    'utf8',
  ).toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

export type StateFailure = 'malformed' | 'bad_signature' | 'expired' | 'wrong_account'

export function verifyOauthState(
  value: string,
  secret: string,
  expect: { accountId: string; now?: Date },
): { ok: true; state: OauthState } | { ok: false; reason: StateFailure } {
  const [payload, signature] = value.split('.')
  if (!payload || !signature) return { ok: false, reason: 'malformed' }
  if (!safeEqual(signature, sign(payload, secret))) return { ok: false, reason: 'bad_signature' }

  let decoded: { a?: unknown; s?: unknown; t?: unknown }
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof decoded
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (typeof decoded.a !== 'string' || typeof decoded.s !== 'string' || typeof decoded.t !== 'number') {
    return { ok: false, reason: 'malformed' }
  }

  const now = (expect.now ?? new Date()).getTime()
  if (now - decoded.t > STATE_TTL_MS || decoded.t > now + 60_000) {
    return { ok: false, reason: 'expired' }
  }
  // The session decides whose install this is. A state lifted from somebody
  // else's browser therefore completes nothing.
  if (decoded.a !== expect.accountId) return { ok: false, reason: 'wrong_account' }

  return { ok: true, state: { accountId: decoded.a, shop: decoded.s, issuedAt: decoded.t } }
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('base64url')
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length || left.length === 0) return false
  return timingSafeEqual(left, right)
}

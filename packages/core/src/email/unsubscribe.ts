import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * One-click unsubscribe. Gmail and Yahoo require bulk mail to carry a link that
 * switches it off in a single request, with no sign-in — so the link itself has
 * to be the proof of who is asking.
 *
 * It is a signed statement of two things and nothing else: which account, and
 * which setting. It cannot be edited into somebody else's account, and it
 * carries no session, so a link forwarded to a friend switches off the original
 * merchant's email and grants no other access whatsoever.
 *
 * No expiry, deliberately. A mailbox is read late; an unsubscribe link that has
 * gone stale is a complaint to a mail provider rather than a preference change,
 * and that costs far more than the link staying live.
 */

/** The `notification_prefs` columns a link may switch off. */
export type UnsubscribeTarget = 'email_article_published' | 'email_digest_frequency'

export const UNSUBSCRIBE_TARGETS: readonly UnsubscribeTarget[] = [
  'email_article_published',
  'email_digest_frequency',
]

export interface UnsubscribeClaim {
  readonly accountId: string
  readonly target: UnsubscribeTarget
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function mintUnsubscribeToken(claim: UnsubscribeClaim, secret: string): string {
  if (!secret) throw new Error('An unsubscribe link cannot be signed without a secret.')
  const payload = `${claim.accountId}.${claim.target}`
  return `${payload}.${sign(payload, secret)}`
}

/** Undefined for anything that was not signed by us, with no hint as to which part was wrong. */
export function readUnsubscribeToken(token: string, secret: string): UnsubscribeClaim | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  const [accountId, target, signature] = parts as [string, string, string]
  if (!UNSUBSCRIBE_TARGETS.includes(target as UnsubscribeTarget)) return undefined

  const expected = Buffer.from(sign(`${accountId}.${target}`, secret))
  const given = Buffer.from(signature)
  // Length has to match before the constant-time compare, and comparing lengths
  // first leaks nothing a base64url signature does not already show.
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined
  return { accountId, target: target as UnsubscribeTarget }
}

/**
 * The two headers that make it one click. `List-Unsubscribe-Post` is what tells
 * the mail client it may POST the link itself instead of opening a browser —
 * without it the header is only a hint and the merchant still has to visit a
 * page (RFC 8058).
 */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  }
}

export function unsubscribeUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, '')}/api/notifications/unsubscribe?token=${encodeURIComponent(token)}`
}

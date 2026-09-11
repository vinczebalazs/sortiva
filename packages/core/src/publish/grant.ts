import { createHmac, timingSafeEqual } from 'node:crypto'
import { SHOPIFY_PUBLISH_SCOPE, SHOPIFY_READ_SCOPES } from '../catalog/scopes'

/**
 * Permission to post on a merchant's blog, which is a second conversation with
 * them and never part of the first.
 *
 * Installing Sortiva asks for read permission only, and the connect screen says
 * so in those words. Posting needs `write_content`, and a merchant grants that
 * separately — from Settings, or the first time they try to publish — because
 * the fear that stops a merchant installing an SEO tool is waking up to posts
 * they did not ask for. Keeping the two grants apart is what makes the promise
 * on the install screen true rather than merely worded well.
 *
 * The second grant also cannot stand alone: a store with posting permission and
 * no chosen blog has nowhere to post. So "may auto-publish be switched on" is
 * one question with two halves, asked in one place, and answered here.
 */

/**
 * The one write permission Sortiva ever asks for. It posts articles; it cannot
 * touch anything else. Declared beside the read permissions, because the
 * install has to recognise it coming back from a merchant who granted it once.
 */
export { SHOPIFY_PUBLISH_SCOPE }

/**
 * What the *second* consent screen asks for: everything the first one already
 * has, plus permission to post.
 *
 * Shopify replaces a token's whole scope set on each grant rather than adding
 * to it, so leaving the read scopes out here would trade a working catalogue
 * sync for the ability to publish.
 */
export const SHOPIFY_PUBLISH_SCOPES = [...SHOPIFY_READ_SCOPES, SHOPIFY_PUBLISH_SCOPE] as const

/** The scope string Shopify's authorize URL expects for the publishing grant. */
export const SHOPIFY_PUBLISH_SCOPE_PARAM = SHOPIFY_PUBLISH_SCOPES.join(',')

export class PublishScopeMissing extends Error {
  override readonly name = 'PublishScopeMissing'
  readonly errorClass = 'shopify_publish_scope_missing'
  constructor(readonly scopes: readonly string[]) {
    super(
      `Shopify did not grant ${SHOPIFY_PUBLISH_SCOPE}; it granted: ${scopes.join(', ') || 'nothing'}. ` +
        `Refusing to record a publishing connection that cannot publish.`,
    )
  }
}

/**
 * Refuses a second grant that came back without posting permission.
 *
 * The merchant can untick permissions on Shopify's own consent screen, and a
 * connection recorded as "can publish" when it cannot would fail at the publish
 * hour instead of at the moment the merchant could still fix it.
 */
export function assertPublishGrant(granted: readonly string[]): void {
  if (!granted.includes(SHOPIFY_PUBLISH_SCOPE)) throw new PublishScopeMissing(granted)
}

/** Why auto-publish cannot be switched on yet. Both are steps in turning it on, not failures. */
export type AutoPublishBlocker =
  /** No posting permission: the second Shopify grant has not been made. */
  | 'write_scope_required'
  /** Permission exists, but no blog has been chosen to post to. */
  | 'target_blog_unresolved'

export type AutoPublishReadiness =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: AutoPublishBlocker }

export interface AutoPublishState {
  readonly grantedScopes: readonly string[]
  /** The blog chosen as the posting target, or null when none has been. */
  readonly targetBlogId: string | null
}

/**
 * The single answer to "may this store publish on its own?".
 *
 * Called both when the merchant asks to switch auto-publish on and again at the
 * publish hour, because a grant can be withdrawn between the two: a merchant
 * who removes our posting permission in Shopify's admin must stop being
 * published for, not fail halfway through a post.
 *
 * The order matters to the merchant, not to us — permission first, because the
 * blog list cannot be read without it, so offering a blog picker to a store
 * that has not granted anything would show an empty list and no reason for it.
 */
export function autoPublishReadiness(state: AutoPublishState): AutoPublishReadiness {
  if (!state.grantedScopes.includes(SHOPIFY_PUBLISH_SCOPE)) {
    return { ok: false, code: 'write_scope_required' }
  }
  if (!state.targetBlogId) return { ok: false, code: 'target_blog_unresolved' }
  return { ok: true }
}

// ── The round trip to Shopify and back ──────────────────────────────────────

/**
 * Our own value carried through Shopify's consent screen and handed back on the
 * redirect, signed so it cannot be written by anyone else.
 *
 * It exists to answer three questions on the way back that the redirect itself
 * cannot be trusted for: whose account this grant belongs to, which store it
 * was for, and that this really is the *publishing* pass rather than an install
 * redirect replayed at it. Without the purpose, a merchant's read-only install
 * callback could be pointed at this one and a read grant recorded as a
 * publishing one.
 */
export const PUBLISH_GRANT_PURPOSE = 'shopify_publish_grant'

export interface PublishGrantState {
  readonly accountId: string
  readonly shop: string
  readonly issuedAt: number
}

/** Ten minutes: long enough to read a consent screen, short enough that a leaked link is stale. */
export const PUBLISH_GRANT_STATE_TTL_MS = 10 * 60 * 1000

export function signPublishGrantState(state: PublishGrantState, secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({ ...state, purpose: PUBLISH_GRANT_PURPOSE }),
    'utf8',
  ).toString('base64url')
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

/**
 * Returns the state only when the signature, the purpose and the age all hold.
 * Anything else answers `undefined`: a caller must not be able to tell a forged
 * value from an expired one and act differently on it.
 */
export function verifyPublishGrantState(
  value: string,
  secret: string,
  now: Date = new Date(),
): PublishGrantState | undefined {
  const dot = value.lastIndexOf('.')
  if (dot <= 0) return undefined
  const payload = value.slice(0, dot)
  const provided = value.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(payload).digest('base64url')
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length || a.length === 0 || !timingSafeEqual(a, b)) return undefined

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (parsed['purpose'] !== PUBLISH_GRANT_PURPOSE) return undefined
  const accountId = parsed['accountId']
  const shop = parsed['shop']
  const issuedAt = parsed['issuedAt']
  if (typeof accountId !== 'string' || typeof shop !== 'string' || typeof issuedAt !== 'number') {
    return undefined
  }
  if (now.getTime() - issuedAt > PUBLISH_GRANT_STATE_TTL_MS) return undefined
  return { accountId, shop, issuedAt }
}

import {
  defaultNotificationPreferences,
  readUnsubscribeToken,
  type UnsubscribeTarget,
} from '@sortiva/core'
import { makeEmailStore, type Db } from '@sortiva/db'
import { t } from '@sortiva/ui/strings/translate'

/**
 * One-click unsubscribe.
 *
 * Unauthenticated on purpose: Gmail and Yahoo require bulk mail to carry a link
 * that switches it off in a single request, with no sign-in. The link is
 * therefore the proof of who is asking — a signature over the account and the
 * one setting it may change, and nothing else. A forwarded email switches off
 * the original merchant's mail and grants no other access.
 *
 * Both verbs work and both do the same thing. A mail client acting on the
 * header sends POST; a merchant clicking the link in the body sends GET, and
 * gets a page saying it worked.
 *
 * The answer is the same whether the token was ours or not. A response that
 * distinguished them would let someone probe for valid account ids from a
 * public endpoint, and there is nothing useful to tell a person holding a link
 * we did not write.
 */

export interface UnsubscribeOptions {
  database?: Db
  secret?: string
}

export async function handleUnsubscribe(
  request: Request,
  options: UnsubscribeOptions = {},
): Promise<Response> {
  const token = await readToken(request)
  const secret = options.secret ?? process.env.AUTH_SECRET ?? ''
  const claim = token && secret ? readUnsubscribeToken(token, secret) : undefined

  if (claim) {
    const store = makeEmailStore(options.database ? { database: options.database } : {})
    // Read then write both columns. The row does not exist until a merchant
    // changes something, and writing one column would let the other take its
    // database default — switching off something nobody asked about.
    const current = (await store.preferences(claim.accountId)) ?? defaultNotificationPreferences()
    await store.savePreferences(claim.accountId, { ...current, ...turnOff(claim.target) })
  }

  if (request.method === 'POST') return new Response(null, { status: 204 })
  return new Response(page(), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function turnOff(target: UnsubscribeTarget) {
  return target === 'email_article_published'
    ? ({ emailArticlePublished: false } as const)
    : ({ emailDigestFrequency: 'off' } as const)
}

async function readToken(request: Request): Promise<string | undefined> {
  const fromQuery = new URL(request.url).searchParams.get('token')
  if (fromQuery) return fromQuery
  if (request.method !== 'POST') return undefined
  // RFC 8058 one-click posts `List-Unsubscribe=One-Click` as a form body; the
  // token is in the URL, but some clients re-post the body as well.
  const body = await request.text().catch(() => '')
  return new URLSearchParams(body).get('token') ?? undefined
}

/** The smallest confirmation that can be a page. Every word comes from the string catalogue. */
function page(): string {
  const title = escape(t('unsubscribe.title'))
  const body = escape(t('unsubscribe.body'))
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;margin:0;padding:48px 24px;background:#f6f6f4;color:#141413"><main style="max-width:32rem;margin:0 auto"><h1 style="font-size:1.4rem;margin:0 0 12px">${title}</h1><p style="line-height:1.6;margin:0">${body}</p></main></body></html>`
}

function escape(value: string): string {
  return value.replace(/[&<>"]/g, (char) =>
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : '&quot;',
  )
}

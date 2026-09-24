import {
  assertPublishGrant,
  autoPublishReadiness,
  PublishScopeMissing,
  signPublishGrantState,
  verifyPublishGrantState,
  type ShopifyAuth,
  type ShopifyOAuthProvider,
  type ShopifyPublishProvider,
} from '@sortiva/core'
import {
  readPublishTarget,
  recordPublishGrant,
  setDeliveryMode,
  setShopifyPublishAs,
  setTargetBlog,
  type Db,
} from '@sortiva/db'
import { t } from '@sortiva/ui/strings/translate'
import type { AccountContext, AccountHandler } from '../../auth/_lib/session'

/**
 * Turning auto-publish on, in the order a merchant actually does it: grant
 * permission to post, choose the blog to post to, then switch it on.
 *
 * Each step is a route because each is a separate act of consent with a
 * separate outcome, and because the middle one has to talk to Shopify to find
 * out what blogs exist. Switching on is refused — with a code the screen knows
 * how to act on — until the first two are done, so the setting can never be on
 * while there is nowhere to post.
 *
 * Every handler is parse → call → serialise. What the grant asks for, whether a
 * store may publish, and what a signed state means are all decided in
 * `packages/core/src/publish`.
 */

export interface PublishGrantDeps {
  readonly db: Db
  /** Absent when this deployment has no Shopify credentials; every route then refuses. */
  readonly shopify?: ShopifyPublishProvider
  /** Trading Shopify's one-time code for a token. The same exchange the install uses. */
  readonly oauth?: Pick<ShopifyOAuthProvider, 'exchangeCode' | 'verifyCallbackSignature'>
  /** Tokens are stored encrypted; this is the only place in these routes that sees a plain one. */
  readonly cipher: { encrypt(value: string): string; decrypt(value: string): string }
  /** How to reach the store: its handle, and a token renewed as it ages. */
  readonly authFor: (accountId: string) => Promise<ShopifyAuth | undefined>
  readonly stateSecret: string
  readonly redirectUri: string
  /** Where the merchant's browser lands after the consent screen. */
  readonly settingsUrl: string
  readonly now?: () => Date
}

const CODES = {
  notConnected: 'shopify_not_connected',
  unavailable: 'publishing_unavailable',
  writeScopeRequired: 'write_scope_required',
  targetBlogUnresolved: 'target_blog_unresolved',
  blogNotFound: 'blog_not_found',
  grantRefused: 'shopify_publish_scope_missing',
  badCallback: 'shopify_callback_unverified',
  exchangeFailed: 'shopify_exchange_failed',
} as const

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status })
}

function notConnected(): Response {
  return error(409, CODES.notConnected, t('settings.publishing.errors.notConnected'))
}

/** A deployment with no Shopify credentials cannot post for anyone, and says so rather than pretending. */
function unavailable(): Response {
  return error(503, CODES.unavailable, t('settings.publishing.errors.unavailable'))
}

/**
 * `POST /api/publish/grant/start` — the *second* Shopify consent screen.
 *
 * Answers with the address rather than redirecting, so the client opens it in
 * the same tab without a redirect chain. The store name comes from the
 * connection the merchant already made and never from the request: letting a
 * caller name the store would let a signed-in merchant be walked into granting
 * posting access on a store that is not theirs.
 */
export function makeStartPublishGrantHandler(deps: PublishGrantDeps): AccountHandler {
  return async (_request, { scope }) => {
    if (!deps.shopify) return unavailable()
    const target = await readPublishTarget(deps.db, scope)
    if (!target) return notConnected()

    const state = signPublishGrantState(
      {
        accountId: scope.accountId,
        shop: target.shopHandle,
        issuedAt: (deps.now?.() ?? new Date()).getTime(),
      },
      deps.stateSecret,
    )
    return Response.json({
      url: deps.shopify.publishAuthorizeUrl({
        shop: target.shopHandle,
        redirectUri: deps.redirectUri,
        state,
      }),
    })
  }
}

/**
 * `GET /api/publish/grant/callback` — the merchant coming back from Shopify.
 *
 * Three things are checked before a token is stored, and none of them can be
 * skipped: Shopify's own signature on the query string, our state value (which
 * carries the account and says this was the *publishing* pass, so an install
 * redirect cannot be replayed here), and that the grant actually contains
 * posting permission. A grant that came back without it is discarded rather
 * than recorded, because a connection marked "can publish" that cannot would
 * fail at the publish hour instead of here, where the merchant can still act.
 */
export function makePublishGrantCallbackHandler(deps: PublishGrantDeps): AccountHandler {
  return async (request, { scope }) => {
    if (!deps.shopify || !deps.oauth) return unavailable()

    const query = Object.fromEntries(new URL(request.url).searchParams.entries())
    if (!deps.oauth.verifyCallbackSignature({ query })) {
      return redirectWith(deps.settingsUrl, CODES.badCallback)
    }

    const state = query['state']
      ? verifyPublishGrantState(query['state'], deps.stateSecret, deps.now?.() ?? new Date())
      : undefined
    // The signed-in merchant must be the one the grant was started for. Without
    // this a state value lifted from one session would attach another store's
    // token to whoever opened the link.
    if (!state || state.accountId !== scope.accountId) {
      return redirectWith(deps.settingsUrl, CODES.badCallback)
    }

    const code = query['code']
    if (!code) return redirectWith(deps.settingsUrl, CODES.badCallback)

    let grant
    try {
      grant = await deps.oauth.exchangeCode({ shop: state.shop, code })
    } catch {
      // Shopify would not trade the code — it was already spent, or it expired
      // while the merchant left the tab open. A page saying so is what the
      // merchant can act on; an unhandled error here showed them a crash.
      return redirectWith(deps.settingsUrl, CODES.exchangeFailed)
    }
    try {
      assertPublishGrant(grant.grantedScopes)
    } catch (caught) {
      if (caught instanceof PublishScopeMissing) {
        return redirectWith(deps.settingsUrl, CODES.grantRefused)
      }
      throw caught
    }

    const stored = await recordPublishGrant(deps.db, scope, {
      shopHandle: state.shop,
      accessTokenCipher: deps.cipher.encrypt(grant.accessToken),
      accessTokenExpiresAt: grant.expiresAt,
      refreshTokenCipher: grant.refreshToken === null ? null : deps.cipher.encrypt(grant.refreshToken),
      refreshTokenExpiresAt: grant.refreshTokenExpiresAt,
      grantedScopes: grant.grantedScopes,
      // Recorded permanently: it is what lets this merchant reconnect later
      // without their publishing permission being thrown away as unasked-for.
      publishGrantedAt: deps.now?.() ?? new Date(),
    })
    if (!stored) return redirectWith(deps.settingsUrl, CODES.notConnected)

    // Back to the blog picker, which is the next thing the merchant has to do.
    return redirectWith(deps.settingsUrl, undefined)
  }
}

function redirectWith(settingsUrl: string, code: string | undefined): Response {
  const url = new URL(settingsUrl)
  if (code) url.searchParams.set('publish_grant_error', code)
  else url.searchParams.set('publish_grant', 'granted')
  return Response.redirect(url.toString(), 303)
}

/**
 * `GET /api/publish/blogs` — what the merchant can choose to post to.
 *
 * Reading the list needs the posting grant, so a store that has not made it is
 * told which step it is on rather than shown an empty list with no explanation.
 */
export function makeListBlogsHandler(deps: PublishGrantDeps): AccountHandler {
  return async (_request, { scope }) => {
    if (!deps.shopify) return unavailable()
    const target = await readPublishTarget(deps.db, scope)
    if (!target) return notConnected()
    if (!target.grantedScopes.includes('write_content')) {
      return error(409, CODES.writeScopeRequired, t('settings.publishing.errors.writeScopeRequired'))
    }

    const auth = await deps.authFor(scope.accountId)
    if (!auth) return notConnected()
    const blogs = await deps.shopify.listBlogs({ auth })
    return Response.json({ blogs })
  }
}

/**
 * `POST /api/publish/target` — choose the blog, or create one in a click.
 *
 * Creating is offered because a store with no blog otherwise has to leave
 * Sortiva, find Shopify's blog settings, and come back. Creation and posting
 * need the same permission, so there is no extra consent to ask for.
 */
export function makeSetTargetBlogHandler(deps: PublishGrantDeps): AccountHandler {
  return async (request, { scope }) => {
    if (!deps.shopify) return unavailable()
    const body = (await request.json().catch(() => null)) as
      | { blogId?: unknown; createNamed?: unknown }
      | null
    const blogId = typeof body?.blogId === 'string' ? body.blogId : undefined
    const createNamed =
      typeof body?.createNamed === 'string' && body.createNamed.trim().length > 0
        ? body.createNamed.trim()
        : undefined
    if (!blogId && !createNamed) {
      return error(422, 'blog_not_named', t('settings.publishing.errors.blogNotNamed'))
    }

    const target = await readPublishTarget(deps.db, scope)
    if (!target) return notConnected()
    if (!target.grantedScopes.includes('write_content')) {
      return error(409, CODES.writeScopeRequired, t('settings.publishing.errors.writeScopeRequired'))
    }

    const auth = await deps.authFor(scope.accountId)
    if (!auth) return notConnected()
    const credentials = { auth }
    const chosen = createNamed
      ? await deps.shopify.createBlog({ ...credentials, title: createNamed })
      : (await deps.shopify.listBlogs(credentials)).find((blog) => blog.id === blogId)
    // A blog id from a list the merchant loaded minutes ago may name a blog
    // that has since been deleted. Checked against the store rather than
    // trusted, so the target we record is one that exists.
    if (!chosen) return error(409, CODES.blogNotFound, t('settings.publishing.errors.blogNotFound'))

    const saved = await setTargetBlog(deps.db, scope, {
      blogId: chosen.id,
      blogHandle: chosen.handle,
    })
    if (!saved) {
      return error(409, CODES.writeScopeRequired, t('settings.publishing.errors.writeScopeRequired'))
    }
    return Response.json({ ok: true, blog: chosen })
  }
}

/**
 * `POST /api/publish/mode` — switch auto-publish on or off, and choose whether
 * posts go live or wait as Shopify drafts.
 *
 * Switching **on** is refused with a machine-readable code until posting is
 * permitted and a blog is chosen. Those are not failures: the screen treats
 * each as the next step in turning the toggle on. Switching **off** always
 * works, whatever state the connection is in — withdrawing consent must not
 * depend on anything continuing to function.
 */
export function makeSetDeliveryModeHandler(deps: PublishGrantDeps): AccountHandler {
  return async (request, context: AccountContext) => {
    const scope = context.scope
    const body = (await request.json().catch(() => null)) as
      | { delivery?: unknown; shopifyPublishAs?: unknown }
      | null

    if (body?.shopifyPublishAs === 'live' || body?.shopifyPublishAs === 'draft') {
      await setShopifyPublishAs(deps.db, scope, body.shopifyPublishAs)
    }

    if (body?.delivery !== 'auto' && body?.delivery !== 'export') {
      if (body?.shopifyPublishAs === 'live' || body?.shopifyPublishAs === 'draft') {
        return Response.json({ ok: true })
      }
      return error(422, 'delivery_invalid', t('settings.publishing.errors.deliveryInvalid'))
    }

    if (body.delivery === 'export') {
      await setDeliveryMode(deps.db, scope, 'export')
      return Response.json({ ok: true, delivery: 'export' })
    }

    const target = await readPublishTarget(deps.db, scope)
    if (!target) return notConnected()

    const readiness = autoPublishReadiness({
      grantedScopes: target.grantedScopes,
      targetBlogId: target.targetBlogId,
    })
    if (!readiness.ok) {
      return error(
        409,
        readiness.code,
        readiness.code === 'write_scope_required'
          ? t('settings.publishing.errors.writeScopeRequired')
          : t('settings.publishing.errors.targetBlogUnresolved'),
      )
    }

    // The same two conditions again, this time as a `WHERE` clause. A caller
    // that got here with a stale read of the connection still cannot turn the
    // setting on.
    const switched = await setDeliveryMode(deps.db, scope, 'auto')
    if (!switched) {
      return error(
        409,
        CODES.targetBlogUnresolved,
        t('settings.publishing.errors.targetBlogUnresolved'),
      )
    }
    return Response.json({ ok: true, delivery: 'auto' })
  }
}

import {
  assertReadOnlyGrant,
  WriteScopeGranted,
  type ShopifyAccessGrant,
  type ShopifyOAuthProvider,
  type StoreConnection,
} from '@sortiva/core'
import type { AccountHandler } from '../../auth/_lib/session'
import { signOauthState, verifyOauthState } from './state'

/**
 * The two ends of the install handshake: send the merchant to Shopify, and take
 * them back afterwards.
 *
 * Both are parse → call out → serialise. What we ask Shopify for, and what we
 * refuse to accept back, is decided in `packages/core`; what a valid return trip
 * looks like is decided by Shopify's signature and by our own state value.
 *
 * Each takes a factory rather than the dependencies themselves. Building them
 * opens a database connection, and a route module is evaluated at build time as
 * well as at request time — so constructing them eagerly makes `next build` try
 * to connect to a database that is not there.
 */

export interface ShopifyOauthDeps {
  readonly oauth: ShopifyOAuthProvider
  /** Signs and checks our own state value. The app secret does double duty. */
  readonly stateSecret: string
  readonly redirectUri: string
  /** Where the browser goes once the connection is made or refused. */
  readonly dashboardUrl: string
  /** The store name detection found, or undefined if it never ran or found none. */
  readShopHandle(accountId: string): Promise<string | undefined>
  saveConnection(
    input: { accountId: string; shopHandle: string } & ShopifyAccessGrant,
  ): Promise<StoreConnection>
  /** Which account currently holds this store, if any. A store belongs to one. */
  accountHoldingShop(shopHandle: string): Promise<string | undefined>
  /** When this account first allowed publishing, or null if it never did. */
  publishGrantedAt(accountId: string): Promise<Date | null>
  /**
   * Puts a store that had lost its connection back where it was, and makes the
   * steps that stopped for the dead token due again.
   */
  resumeAfterReconnect(accountId: string): Promise<unknown>
  /** Resumes onboarding now that permission exists. Failures here never fail the callback. */
  resumeIngestion(accountId: string): Promise<void>
  now?(): Date
}

export const START_CODES = {
  notDetectedYet: 'shopify_not_detected',
} as const

export const CALLBACK_CODES = {
  badSignature: 'shopify_callback_unverified',
  badState: 'shopify_callback_state_invalid',
  missingParams: 'shopify_callback_incomplete',
  wrongStore: 'shopify_callback_wrong_store',
  writeScope: 'shopify_write_scope_refused',
  exchangeFailed: 'shopify_exchange_failed',
  storeTaken: 'shopify_store_taken',
} as const

/**
 * `POST /api/shopify/oauth/start`. Answers with the address to send the browser
 * to, rather than redirecting itself, so the client can open it in the same tab
 * without a form post and a redirect chain.
 *
 * The store name comes from what detection found and never from the request:
 * letting a caller name the store would let a signed-in merchant be walked into
 * installing us on a store that is not theirs.
 */
export function makeStartHandler(getDeps: () => ShopifyOauthDeps): AccountHandler {
  return async (_request, { scope }) => {
    const deps = getDeps()
    const shop = await deps.readShopHandle(scope.accountId)
    if (!shop) {
      return errorResponse(
        409,
        START_CODES.notDetectedYet,
        'We are still working out what your store runs on. This page will move on by itself.',
      )
    }

    const state = signOauthState(
      { accountId: scope.accountId, shop, issuedAt: (deps.now?.() ?? new Date()).getTime() },
      deps.stateSecret,
    )

    return Response.json({
      url: deps.oauth.authorizeUrl({ shop, redirectUri: deps.redirectUri, state }),
    })
  }
}

/**
 * `GET /api/shopify/oauth/callback`. Shopify sends the merchant's browser here.
 *
 * Four checks before a token is ever requested, in this order: the parameters we
 * need are present, Shopify's own signature over them holds, our state value is
 * ours and belongs to this session's account, and the store named is the one the
 * state was issued for. Only then do we trade the code.
 *
 * The reply is a redirect either way, because a browser is what arrives — the
 * outcome travels as a query parameter the dashboard reads.
 */
export function makeCallbackHandler(getDeps: () => ShopifyOauthDeps): AccountHandler {
  return async (request, { scope }) => {
    const deps = getDeps()
    const query = queryOf(request)
    const shopParam = query['shop']
    const code = query['code']
    const state = query['state']

    if (!shopParam || !code || !state) {
      return redirectWith(deps.dashboardUrl, CALLBACK_CODES.missingParams)
    }

    if (!deps.oauth.verifyCallbackSignature({ query })) {
      return redirectWith(deps.dashboardUrl, CALLBACK_CODES.badSignature)
    }

    const verified = verifyOauthState(state, deps.stateSecret, {
      accountId: scope.accountId,
      ...(deps.now ? { now: deps.now() } : {}),
    })
    if (!verified.ok) {
      return redirectWith(deps.dashboardUrl, CALLBACK_CODES.badState)
    }

    // Shopify sends the full `acme.myshopify.com`; our state carries the name.
    const shop = shopParam.toLowerCase().replace(/\.myshopify\.com$/, '')
    if (shop !== verified.state.shop) {
      return redirectWith(deps.dashboardUrl, CALLBACK_CODES.wrongStore)
    }

    // A store belongs to one account. Checked before the code is spent, so a
    // merchant who signed up twice is told plainly rather than meeting a
    // database error — and so the other account's live connection, which is the
    // one actually working, is never disturbed.
    const owner = await deps.accountHoldingShop(shop)
    if (owner && owner !== scope.accountId) {
      return redirectWith(deps.dashboardUrl, CALLBACK_CODES.storeTaken)
    }

    let grant
    try {
      grant = await deps.oauth.exchangeCode({ shop, code })
    } catch {
      return redirectWith(deps.dashboardUrl, CALLBACK_CODES.exchangeFailed)
    }

    // A merchant who has already said yes to publishing is handed that
    // permission back by Shopify whether we ask for it or not. Refusing their
    // token would lock out precisely the merchants who trusted us most: they
    // could never reconnect at all.
    const publishGrantedBefore = (await deps.publishGrantedAt(scope.accountId)) != null
    try {
      assertReadOnlyGrant(grant.grantedScopes, { publishGrantedBefore })
    } catch (error) {
      if (error instanceof WriteScopeGranted) {
        // We promised on the connect screen that this permission cannot change
        // anything in their store. Storing a token that can would make that
        // false, so the token is dropped.
        return redirectWith(deps.dashboardUrl, CALLBACK_CODES.writeScope)
      }
      throw error
    }

    await deps.saveConnection({ accountId: scope.accountId, shopHandle: shop, ...grant })

    // A store whose connection had died is waiting on the reconnect screen with
    // its onboarding steps recorded as failed. Reviving them is what makes this
    // a reconnection rather than a token quietly replaced under a store nothing
    // will ever work on again.
    await deps.resumeAfterReconnect(scope.accountId).catch(() => undefined)

    // Queued, not awaited. Onboarding is a catalogue walk, several model calls
    // and paid search data — minutes of work — and awaiting it here left the
    // merchant's browser hanging on the redirect from Shopify until it timed
    // out and showed an error for a connection that had in fact been made.
    //
    // A queue that is briefly unavailable must still not make a successful
    // connection look like a failure: the nightly sweep picks such a store up.
    await deps.resumeIngestion(scope.accountId).catch(() => undefined)

    return Response.redirect(`${deps.dashboardUrl}?connected=shopify`, 302)
  }
}

function queryOf(request: Request): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of new URL(request.url).searchParams) out[key] = value
  return out
}

function redirectWith(dashboardUrl: string, code: string): Response {
  return Response.redirect(`${dashboardUrl}?shopify_error=${encodeURIComponent(code)}`, 302)
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status })
}

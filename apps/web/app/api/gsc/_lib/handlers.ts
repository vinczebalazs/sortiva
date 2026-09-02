import {
  GSC_NOT_GRANTED_MESSAGE,
  GSC_NO_DOMAIN_MESSAGE,
  GSC_PROPERTY_REQUIRED_MESSAGE,
  chooseGscProperty,
  completeGscGrant,
  gscPropertyMismatchHint,
  gscPropertyMismatchMessage,
  listGscProperties,
  selectGscPropertyRequestSchema,
  skipGscConnect,
  startGscConnect,
  type GscConnectDeps,
} from '@sortiva/core'
import type { AccountHandler } from '../../auth/_lib/session'
import { gscConnectDeps, gscRedirectUri, gscReturnUrl } from './config'
import { createOAuthState, OAuthStateInvalid, verifyOAuthState } from './state'

/**
 * The four requests the Search Console connection is made of, plus the redirect
 * Google itself calls. Parse, hand to core, serialise — the decisions are all
 * in `@sortiva/core`.
 */

export interface GscHandlerOptions {
  deps?: GscConnectDeps
  now?: () => Date
}

function deps(options: GscHandlerOptions): GscConnectDeps {
  return options.deps ?? gscConnectDeps()
}

/** `POST /api/gsc/oauth/start` */
export function makeGscStartHandler(options: GscHandlerOptions = {}): AccountHandler {
  return async (_request, { scope }) => {
    const now = options.now?.() ?? new Date()
    const { redirectUrl } = startGscConnect(deps(options), {
      state: createOAuthState(scope.accountId, now),
      redirectUri: gscRedirectUri(),
    })
    return Response.json({ redirectUrl }, { status: 200 })
  }
}

/**
 * `GET /api/gsc/oauth/callback` — Google's own redirect, not an API the front
 * end calls, so it answers with a redirect rather than JSON. Every outcome ends
 * on the same screen with the result in the query string; nothing here can leave
 * the merchant on a blank page.
 */
export function makeGscCallbackHandler(options: GscHandlerOptions = {}): AccountHandler {
  return async (request, { scope }) => {
    const url = new URL(request.url)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')

    // The merchant pressed "no" on Google's consent screen. Not an error: the
    // step is optional and stays optional.
    if (url.searchParams.get('error') || !code) return redirect(gscReturnUrl('denied'))
    if (!state) return redirect(gscReturnUrl('failed'))

    try {
      verifyOAuthState(state, scope.accountId, options.now?.() ?? new Date())
    } catch (error) {
      if (error instanceof OAuthStateInvalid) return redirect(gscReturnUrl('failed'))
      throw error
    }

    await completeGscGrant(deps(options), {
      accountId: scope.accountId,
      code,
      redirectUri: gscRedirectUri(),
    })

    // Access granted, property not yet chosen — the picker is the next screen.
    return redirect(gscReturnUrl('granted'))
  }
}

/** `GET /api/gsc/properties` */
export function makeGscPropertiesHandler(options: GscHandlerOptions = {}): AccountHandler {
  return async (_request, { scope }) => {
    const result = await listGscProperties(deps(options), { accountId: scope.accountId })
    switch (result.kind) {
      case 'properties':
        return Response.json({ properties: result.properties }, { status: 200 })
      case 'not_granted':
        return error(409, 'gsc_not_granted', GSC_NOT_GRANTED_MESSAGE)
      case 'no_domain':
        return error(409, 'domain_not_claimed', GSC_NO_DOMAIN_MESSAGE)
    }
  }
}

/** `POST /api/gsc/property` */
export function makeGscSelectPropertyHandler(options: GscHandlerOptions = {}): AccountHandler {
  return async (request, { scope }) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return error(422, 'invalid_body', 'Expected a JSON body.')
    }

    const parsed = selectGscPropertyRequestSchema.safeParse(body)
    if (!parsed.success) {
      return error(422, 'invalid_body', GSC_PROPERTY_REQUIRED_MESSAGE)
    }

    const result = await chooseGscProperty(deps(options), {
      accountId: scope.accountId,
      siteUrl: parsed.data.siteUrl,
    })

    switch (result.kind) {
      case 'selected':
        return Response.json({ ok: true }, { status: 200 })
      case 'host_mismatch':
        // A 422 rather than a 409: nothing raced, the merchant chose a property
        // for a different website. The claimed domain travels with it so the
        // screen can name the store we are talking about.
        return Response.json(
          {
            error: {
              code: 'gsc_property_mismatch',
              message: gscPropertyMismatchMessage(result.claimedDomain),
              details: [{ path: 'siteUrl', message: gscPropertyMismatchHint(result.claimedDomain) }],
            },
          },
          { status: 422 },
        )
      case 'not_granted':
        return error(409, 'gsc_not_granted', GSC_NOT_GRANTED_MESSAGE)
      case 'no_domain':
        return error(409, 'domain_not_claimed', GSC_NO_DOMAIN_MESSAGE)
    }
  }
}

/** `POST /api/gsc/skip` */
export function makeGscSkipHandler(options: GscHandlerOptions = {}): AccountHandler {
  return async (_request, { scope }) => {
    await skipGscConnect(deps(options), { accountId: scope.accountId })
    return Response.json({ ok: true }, { status: 200 })
  }
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } })
}

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status })
}

export const gscStartHandler = makeGscStartHandler()
export const gscCallbackHandler = makeGscCallbackHandler()
export const gscPropertiesHandler = makeGscPropertiesHandler()
export const gscSelectPropertyHandler = makeGscSelectPropertyHandler()
export const gscSkipHandler = makeGscSkipHandler()

import type { GscConnectDeps } from '@sortiva/core'
import { makeGscConnectStore } from '@sortiva/db'
import { enqueueGscBackfill } from '@sortiva/jobs/gsc/queue'
import { GscOAuthProvider, PosthogServerCapture, TokenCipher } from '@sortiva/providers'
import type { OAuthReturn } from './state'

/**
 * The connect flow's process-wide wiring, built lazily: the Google credentials
 * and the encryption key do not exist at build time, and a module-level client
 * would fail `next build`.
 */

let provider: GscOAuthProvider | undefined
let cipher: TokenCipher | undefined
let capture: PosthogServerCapture | undefined

/**
 * Where Google sends the merchant back to. Registered with Google as an exact
 * string, so it is derived from configuration rather than from the incoming
 * request — a redirect built from a request header is a redirect an attacker can
 * choose.
 */
export function gscRedirectUri(): string {
  const origin = process.env.APP_URL
  if (!origin) throw new Error('APP_URL is not set; the Search Console redirect cannot be built.')
  return `${origin.replace(/\/$/, '')}/api/gsc/oauth/callback`
}

/**
 * Where the merchant lands after the flow, with the outcome in the query string.
 *
 * Two screens, because connecting Search Console starts from two places: the
 * dashboard's onboarding card, and Settings → Connections. It used to be one
 * fixed path, and the wrong one — every merchant was returned to Settings,
 * which had no property picker on it, so the screen said "connected" while no
 * property had been chosen, no history import had been queued, and the account
 * stayed on limited data. The screen was telling the truth about the grant and
 * a lie about the connection.
 *
 * The name comes out of the signed state and is turned into a path **here**, so
 * a forged state can choose between these two and nothing else.
 */
const RETURN_PATHS: Readonly<Record<OAuthReturn, string>> = {
  dashboard: '/dashboard',
  connections: '/settings/connections',
}

export const GSC_RETURN_PATH = RETURN_PATHS.connections

export function gscReturnUrl(
  outcome: 'granted' | 'denied' | 'failed',
  returnTo: OAuthReturn = 'connections',
): string {
  const origin = (process.env.APP_URL ?? '').replace(/\/$/, '')
  return `${origin}${RETURN_PATHS[returnTo]}?gsc=${outcome}`
}

export function gscConnectDeps(): GscConnectDeps {
  provider ??= new GscOAuthProvider()
  cipher ??= new TokenCipher()
  capture ??= new PosthogServerCapture()
  return {
    store: makeGscConnectStore({
      enqueueBackfill: (database, accountId) => enqueueGscBackfill(database, { accountId }),
    }),
    provider,
    codec: cipher,
    capture,
  }
}

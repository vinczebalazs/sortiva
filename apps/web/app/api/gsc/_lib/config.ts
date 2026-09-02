import type { GscConnectDeps } from '@sortiva/core'
import { makeGscConnectStore } from '@sortiva/db'
import { enqueueGscBackfill } from '@sortiva/jobs/gsc/queue'
import { GscOAuthProvider, PosthogServerCapture, TokenCipher } from '@sortiva/providers'

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
 * One constant, so the day the front end names that screen differently there is
 * one line to change.
 */
export const GSC_RETURN_PATH = '/settings/connections'

export function gscReturnUrl(outcome: 'granted' | 'denied' | 'failed'): string {
  const origin = (process.env.APP_URL ?? '').replace(/\/$/, '')
  return `${origin}${GSC_RETURN_PATH}?gsc=${outcome}`
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

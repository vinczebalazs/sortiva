import { ShopifyOAuthClient, ShopifyPublishClient, TokenCipher } from '@sortiva/providers'
import type { ShopifyPublishProvider } from '@sortiva/core'
import { db } from '@sortiva/db'
import type { PublishGrantDeps } from './handlers'

/**
 * What the auto-publish routes run against.
 *
 * A composition root of its own rather than a reach into the Shopify routes'
 * one: this lane owns the publishing grant and the blog it posts to, and
 * importing across another lane's directory is what the other lanes have each
 * declined to do for the same reason.
 *
 * Every function here is called from **inside** a request handler. Building any
 * of them opens a database connection or reads a key, and a route module is
 * evaluated at build time as well as at request time — doing it at module scope
 * is how earlier cards made `next build` try to connect to a database that is
 * not there.
 */

let cipher: TokenCipher | undefined
let publish: ShopifyPublishClient | undefined
let oauth: ShopifyOAuthClient | undefined

/**
 * One cipher per process: building it reads and validates the master key, and
 * doing that per request would turn a misconfigured key into an error that only
 * appears under load.
 */
export function publishTokenCipher(): TokenCipher {
  cipher ??= new TokenCipher()
  return cipher
}

/**
 * The client that writes to a merchant's shop, or nothing at all.
 *
 * Undefined without Shopify credentials, rather than a stand-in. A stand-in
 * here would accept a post, remember it in memory, and report success — so a
 * misconfigured deployment would tell merchants their articles were live on
 * their own sites when nothing had left the building. Every caller treats the
 * absence as "this store cannot be published for", which is true and visible.
 */
export function publishProvider(): ShopifyPublishProvider | undefined {
  if (!process.env.SHOPIFY_CLIENT_ID) return undefined
  publish ??= new ShopifyPublishClient()
  return publish
}

/**
 * The public address this app answers on. Registered with Shopify against the
 * redirect below, so it is configuration and never derived from the incoming
 * request — a request-derived redirect URI is how an open redirect gets built
 * by accident.
 */
function appUrl(): string {
  return (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
}

/**
 * The publishing grant comes back to its **own** address, not to the install
 * callback.
 *
 * Two different conversations with the merchant end differently: the install
 * finishes on the dashboard with onboarding resuming behind it, and this one
 * finishes back in Settings with a blog still to choose. Sharing one callback
 * would mean one of the two ended in the wrong place, and would put a branch on
 * the read-only path that a write grant could take.
 */
export function publishGrantRedirectUri(): string {
  return `${appUrl()}/api/publish/grant/callback`
}

/**
 * The app secret does double duty: Shopify signs their redirects with it, and
 * we sign our own state value with it. Both answer "did this come from where it
 * says", and a second secret would be one more thing to rotate.
 */
export function publishStateSecret(): string {
  return process.env.SHOPIFY_CLIENT_SECRET ?? process.env.AUTH_SECRET ?? 'development-only-secret'
}

/**
 * The code-for-token exchange, which is the same one the install uses.
 *
 * Undefined without credentials, for the same reason the write client is: an
 * exchange that cannot happen must stop the flow rather than be stood in for.
 */
function grantExchange(): ShopifyOAuthClient | undefined {
  if (!process.env.SHOPIFY_CLIENT_ID || !process.env.SHOPIFY_CLIENT_SECRET) return undefined
  oauth ??= new ShopifyOAuthClient()
  return oauth
}

export function publishGrantDeps(): PublishGrantDeps {
  const provider = publishProvider()
  const exchange = grantExchange()
  return {
    db: db(),
    ...(provider ? { shopify: provider } : {}),
    ...(exchange ? { oauth: exchange } : {}),
    cipher: publishTokenCipher(),
    stateSecret: publishStateSecret(),
    redirectUri: publishGrantRedirectUri(),
    settingsUrl: `${appUrl()}/settings/publishing`,
  }
}

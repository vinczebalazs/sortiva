import {
  GuardedPageFetcher,
  MockShopifyOAuthClient,
  ShopifyAdminClient,
  ShopifyOAuthClient,
  TokenCipher,
} from '@sortiva/providers'
import { StubNotificationEmitter } from '@sortiva/core'
import type { NotificationEmitter, ShopifyOAuthProvider } from '@sortiva/core'
import { db, dbPool } from '@sortiva/db'
// Deep imports, not the package barrel: `@sortiva/jobs`'s index re-exports the
// spend-cap sweep, which pulls `packages/rules` — and that reads its config file
// through a `new URL()` webpack resolves at build time and cannot find. The
// domain claim's store deep-imports for the same reason. See DECISIONS
// 2026-09-01 T1.3.
import { dispatchIngestion } from '@sortiva/jobs/ingestion/dispatch'
import { readDetectedShopHandle } from '@sortiva/jobs/ingestion/steps'
import type { IngestionDeps } from '@sortiva/jobs/ingestion/deps'
import { makeConnectionStore, makeDomainStore, type ConnectionStoreWithSave } from './bindings'
import type { ShopifyOauthDeps } from './handlers'

/**
 * The concrete things the Shopify routes and the onboarding steps run against.
 *
 * Built here rather than inside a handler so a test can hand in its own — and
 * so the decision "which Shopify are we talking to" is made once, in a file
 * whose name says so, rather than implied by an environment variable read deep
 * inside a request.
 *
 * This is a composition root: it names the database, the connection pool and
 * the token cipher, and hands them to things that hold no infrastructure of
 * their own. It runs no query itself. A route handler and a queue task are both
 * called by their framework, so there is no caller of ours to pass these in.
 */

let cipher: TokenCipher | undefined
let admin: ShopifyAdminClient | undefined

/**
 * One Admin client per process, because the pacing lives inside it.
 *
 * Shopify budgets requests per store, and the client spreads background reads
 * across that budget. Two clients would each believe they were the only one
 * talking to a store, and together they would earn the rate limiting the pacing
 * exists to avoid.
 */
export function adminClient(): ShopifyAdminClient {
  admin ??= new ShopifyAdminClient()
  return admin
}

/**
 * One cipher per process. Building it reads and validates the master key, and
 * doing that per request would turn a misconfigured key into an error that only
 * appears under load.
 */
export function tokenCipher(): TokenCipher {
  cipher ??= new TokenCipher()
  return cipher
}

function connections(): ConnectionStoreWithSave {
  return makeConnectionStore(db(), tokenCipher())
}

/**
 * The public address this app answers on. Every OAuth redirect is registered
 * against it with the vendor, so it is configuration and never derived from the
 * incoming request — a request-derived redirect URI is how an open redirect
 * gets built by accident.
 */
function appUrl(): string {
  return (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
}

export function shopifyRedirectUri(): string {
  return `${appUrl()}/api/shopify/oauth/callback`
}

/**
 * Without Shopify credentials — local work, CI — the in-memory Shopify stands
 * in. It signs its callbacks the way Shopify does, so nothing about the route's
 * checks is skipped; only the vendor is.
 */
export function shopifyOauthProvider(): ShopifyOAuthProvider {
  if (!process.env.SHOPIFY_API_KEY || !process.env.SHOPIFY_API_SECRET) {
    return new MockShopifyOAuthClient(stateSecret())
  }
  return new ShopifyOAuthClient()
}

/**
 * The app secret does double duty: it signs our own state value as well as
 * being what Shopify signs their callbacks with. Both are "prove this came from
 * where it says", and a second secret would be one more thing to rotate.
 */
export function stateSecret(): string {
  return process.env.SHOPIFY_API_SECRET ?? process.env.AUTH_SECRET ?? 'development-only-secret'
}

/**
 * Where a notification would go. The real emitter belongs to another lane; until
 * it lands the stub records the emission and says loudly that it is a stub,
 * rather than the call site quietly having none.
 */
export function notificationEmitter(): NotificationEmitter {
  return new StubNotificationEmitter()
}

export function ingestionDeps(): IngestionDeps {
  return {
    db: db(),
    pool: dbPool(),
    fetcher: new GuardedPageFetcher(),
    shopify: shopifyOauthProvider(),
    // One client, used two ways. It must be *the same instance*: the
    // one-request-a-second pacing is kept per store inside it, so a second
    // client would be a second budget and the two together would spend twice
    // what Shopify allows.
    shop: adminClient(),
    admin: adminClient(),
    connections: connections(),
    domains: makeDomainStore(db()),
    notifications: notificationEmitter(),
  }
}

export function shopifyOauthDeps(): ShopifyOauthDeps {
  const store = connections()
  return {
    oauth: shopifyOauthProvider(),
    stateSecret: stateSecret(),
    redirectUri: shopifyRedirectUri(),
    dashboardUrl: `${appUrl()}/dashboard`,
    readShopHandle: (accountId) => readDetectedShopHandle(db(), accountId),
    saveConnection: (input) => store.save(input),
    resumeIngestion: async (accountId) => {
      await dispatchIngestion(ingestionDeps(), { accountId })
    },
  }
}

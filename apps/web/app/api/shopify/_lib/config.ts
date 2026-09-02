import {
  GuardedPageFetcher,
  MockShopifyOAuthClient,
  PosthogServerCapture,
  ShopifyAdminClient,
  ShopifyOAuthClient,
  TokenCipher,
} from '@sortiva/providers'
import type { DistillPrompt, NotificationEmitter, ShopifyOAuthProvider } from '@sortiva/core'
import { db, dbPool, PostgresCostLedger, PostgresRequestCache } from '@sortiva/db'
// Deep imports for the same reason as the jobs imports below: the `@sortiva/llm`
// barrel is small, but this file is loaded by the server's start-up hook, and
// pulling a package's whole surface into that bundle is how the build broke
// before. See DECISIONS 2026-09-01 T1.3.
import { AnthropicLlmClient } from '@sortiva/llm/client'
import { loadPrompt } from '@sortiva/llm/prompts'
// Deep imports, not the package barrel: `@sortiva/jobs`'s index re-exports the
// spend-cap sweep, which pulls `packages/rules` — and that reads its config file
// through a `new URL()` webpack resolves at build time and cannot find. The
// domain claim's store deep-imports for the same reason. See DECISIONS
// 2026-09-01 T1.3.
import { dispatchIngestion } from '@sortiva/jobs/ingestion/dispatch'
import { readDetectedShopHandle } from '@sortiva/jobs/ingestion/steps'
import type { IngestionDeps } from '@sortiva/jobs/ingestion/deps'
import { DbNotificationEmitter } from '@sortiva/jobs/notify/emitter'
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
let llm: AnthropicLlmClient | undefined
let capture: PosthogServerCapture | undefined
let distillPromptCache: DistillPrompt | undefined

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
 * Where a notification goes.
 *
 * Handed the database factory rather than a handle, like everything else here:
 * this module is loaded when its route file is, and opening a connection then
 * would open one during the build.
 */
export function notificationEmitter(): NotificationEmitter {
  return new DbNotificationEmitter(db)
}

/**
 * The one instrumented model client onboarding spends through.
 *
 * Invariant 25: every model call in the product goes through this wrapper, and
 * importing the vendor's own SDK anywhere else is a lint error. It is handed
 * the request cache and the spend ledger here because both are how a step that
 * is retried — and onboarding's steps are retried — does not pay twice for the
 * same answer, and how the daily spend caps see what was spent.
 */
export function ingestionLlm(): AnthropicLlmClient {
  llm ??= new AnthropicLlmClient({
    cache: new PostgresRequestCache(db()),
    capture: ingestionCapture(),
    ledger: new PostgresCostLedger(db()),
  })
  return llm
}

function ingestionCapture(): PosthogServerCapture {
  capture ??= new PosthogServerCapture()
  return capture
}

/**
 * The distillation prompt, by version, from `packages/llm/prompts`.
 *
 * The version is stamped on every fact sheet the step writes, so a year from
 * now any fact can be traced to the exact instructions and model that produced
 * it — which is the whole point of prompts being files rather than strings.
 */
export function distillPrompt(): DistillPrompt {
  if (!distillPromptCache) {
    const prompt = loadPrompt('distill', 1)
    distillPromptCache = { version: prompt.version, text: prompt.text }
  }
  return distillPromptCache
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
    llm: ingestionLlm(),
    distillPrompt: distillPrompt(),
    notifications: notificationEmitter(),
    capture: ingestionCapture(),
  }
}

/**
 * What the Shopify webhook receiver runs against.
 *
 * The database arrives as a factory rather than a handle: the receiver module is
 * loaded when its route file is, and opening a connection then would open one
 * during the build. Naming the concrete database is this file's job — it is the
 * composition root for everything Shopify — and the receiver itself runs no
 * query that does not go through a repository.
 */
export function shopifyWebhookOptions(): { getDatabase: typeof db } {
  return { getDatabase: db }
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

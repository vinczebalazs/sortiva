import { db, dbPool, PostgresCostLedger, PostgresRequestCache } from '@sortiva/db'
import { GuardedPageFetcher, MockSeoDataProvider, PosthogServerCapture } from '@sortiva/providers'
import type { SeoDataProvider } from '@sortiva/core'
import { DataForSeoProvider } from '@sortiva/providers'
// Deep imports, not the package barrel — `@sortiva/llm`'s whole export surface
// is loaded by the server's start-up hook, and pulling it in here is how
// earlier cards broke the build (see DECISIONS 2026-09-01 T1.3).
import { AnthropicLlmClient } from '@sortiva/llm/client'
import { loadPrompt } from '@sortiva/llm/prompts'
import type { GenerationTaskDeps } from '@sortiva/jobs/generation/tasks'
import { DRAFT_PROMPT_MAJOR_VERSION, JUDGE_PROMPT_MAJOR_VERSION } from '@sortiva/jobs/generation/prompts'
import type { PublishTaskDeps } from '@sortiva/jobs/publish/tasks'
import type { DriftTaskDeps } from '@sortiva/jobs/drift/tasks'
import type { ReplenishmentTaskDeps } from '@sortiva/jobs/generation/replenish-tasks'
import { DbOpportunitySource } from '@sortiva/jobs/scan/opportunity-source'
import { DbNotificationEmitter } from '@sortiva/jobs/notify/emitter'
// This lane's own publishing composition root, one directory over: which
// Shopify write client and which token cipher exist in this process.
import { publishProvider, publishTokenCipher } from '../../publish/_lib/config'
import type { DeliveryDeps } from './delivery'
import type { ReviewDeps } from './review'

/**
 * What the review routes and the daily generation cycle are built from.
 *
 * Functions rather than values, and called from inside the request handler or
 * the task registration rather than at module scope: `db()` opens a connection
 * pool, and doing that while Next is collecting a route's exports runs it at
 * build time, in a process that has no database. That is how `T4.2` broke the
 * production build.
 *
 * The search vendor and the capture are this card's own process-wide
 * singletons, the same small shape `apps/web/app/api/shopify/_lib/config.ts`
 * and `apps/web/app/api/calendar/topics/_lib/config.ts` already use for the
 * same services rather than importing across another lane's directory. The
 * model client is the exception: it is exported, and the OPTIMIZE lane spends
 * through this one rather than building a second.
 */

let llm: AnthropicLlmClient | undefined
let capture: PosthogServerCapture | undefined
let seo: SeoDataProvider | undefined

function generationCapture(): PosthogServerCapture {
  capture ??= new PosthogServerCapture()
  return capture
}

/**
 * The one instrumented model client this server process spends through.
 *
 * Exported rather than private because a second client is a second place a
 * merchant's model spend is recorded and a second set of cached answers, so the
 * request cache that makes a retried step free stops working across the two.
 * Named for the process rather than for generation because more than the
 * generation cycle now uses it.
 */
export function processLlm(): AnthropicLlmClient {
  llm ??= new AnthropicLlmClient({
    cache: new PostgresRequestCache(db()),
    capture: generationCapture(),
    ledger: new PostgresCostLedger(db()),
  })
  return llm
}

function generationSeoProvider(): SeoDataProvider {
  if (seo) return seo
  seo =
    process.env.SEO_PROVIDER_MODE === 'mock'
      ? new MockSeoDataProvider({}, generationCapture())
      : new DataForSeoProvider({
          cache: new PostgresRequestCache(db()),
          capture: generationCapture(),
          ledger: new PostgresCostLedger(db()),
        })
  return seo
}

export function reviewDeps(): ReviewDeps {
  return { db: db() }
}

/** What the download and the published-address confirm are built from: the database, and nothing else. */
export function deliveryDeps(): DeliveryDeps {
  return { db: db() }
}

/**
 * What tops the calendar back up when its runway runs short.
 *
 * The opportunities it plans from are read through the frozen
 * `OpportunitySource` seam's real implementation rather than a hand-rolled
 * query, so this and the onboarding scan that seeded the first calendar see
 * exactly the same accepted pool. No model client and no search vendor: the
 * whole of replenishment is arithmetic over rows we already hold, and giving
 * it either would make it possible for a planning pass to start spending.
 */
export function replenishmentTaskDeps(): ReplenishmentTaskDeps {
  return {
    getDb: db,
    getPool: dbPool,
    opportunities: new DbOpportunitySource(db()),
    capture: generationCapture(),
  }
}

/**
 * What hands a finished article to the merchant at their own publish hour.
 *
 * No model client, no search vendor and no page fetcher: delivery spends
 * nothing on vendors. It reads which articles are cleared, hands one over, and
 * records that it did — so giving it any of the paid seams would make it
 * possible for a publish to start writing prose.
 *
 * The Shopify write client and the token cipher are here because an
 * auto-publish store's hand-over *is* a write to their shop. Both are absent
 * when this deployment has no Shopify credentials, and an auto-publish store is
 * then left waiting with that said out loud in the log — never exported
 * instead, which would deliver in a mode the merchant did not choose.
 */
export function publishTaskDeps(): PublishTaskDeps {
  const shopify = publishProvider()
  return {
    getDb: db,
    getPool: dbPool,
    ...(shopify ? { shopify, cipher: publishTokenCipher() } : {}),
    notifications: new DbNotificationEmitter(db),
    capture: generationCapture(),
  }
}

/**
 * The daily check on articles we have already published.
 *
 * The same services the publish hour is given, for the same reason: a repair
 * that mends an article ends by putting the corrected version back on the
 * merchant's shop, through the same posting seam and the same token cipher, so
 * a second client here would be a second place a merchant's credentials are
 * read. On a deployment with no Shopify write client the pass still runs — it
 * still finds what has gone wrong and still tells the merchant — and simply
 * leaves the re-posting owed until one exists.
 */
export function driftTaskDeps(): DriftTaskDeps {
  const shopify = publishProvider()
  return {
    getDb: db,
    getPool: dbPool,
    ...(shopify ? { shopify, cipher: publishTokenCipher() } : {}),
    notifications: new DbNotificationEmitter(db),
    capture: generationCapture(),
  }
}

export function generationTaskDeps(): GenerationTaskDeps {
  return {
    getDb: db,
    getPool: dbPool,
    llm: processLlm(),
    // The one guarded fetcher: every outbound page read in the product goes
    // through it, so the SSRF protections are not something a caller can
    // forget.
    pageFetcher: new GuardedPageFetcher(),
    seo: generationSeoProvider(),
    claimPlanPrompt: loadPrompt('claim-plan', 1),
    draftPrompt: loadPrompt('draft', DRAFT_PROMPT_MAJOR_VERSION),
    judgePrompt: loadPrompt('judge', JUDGE_PROMPT_MAJOR_VERSION),
    contradictionPrompt: loadPrompt('contradiction', 1),
    revisePrompt: loadPrompt('revise', 1),
    // The bell, for the one thing this cycle has to tell a merchant: a draft
    // is waiting for them. Given the factory rather than a handle, for the
    // same reason `getDb` is — nothing opens a connection at registration.
    notifications: new DbNotificationEmitter(db),
    capture: generationCapture(),
  }
}

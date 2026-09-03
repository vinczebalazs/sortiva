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
import type { PublishTaskDeps } from '@sortiva/jobs/publish/tasks'
import type { ReplenishmentTaskDeps } from '@sortiva/jobs/generation/replenish-tasks'
import { DbOpportunitySource } from '@sortiva/jobs/scan/opportunity-source'
import { DbNotificationEmitter } from '@sortiva/jobs/notify/emitter'
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
 * The model client, the search vendor and the capture are this card's own
 * process-wide singletons, the same small shape `apps/web/app/api/shopify/_lib/config.ts`
 * and `apps/web/app/api/calendar/topics/_lib/config.ts` already use for the
 * same three services rather than importing across another lane's directory.
 */

let llm: AnthropicLlmClient | undefined
let capture: PosthogServerCapture | undefined
let seo: SeoDataProvider | undefined

function generationCapture(): PosthogServerCapture {
  capture ??= new PosthogServerCapture()
  return capture
}

function generationLlm(): AnthropicLlmClient {
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
 * nothing. It reads which articles are cleared, moves one of them, and records
 * that it did — so giving it any of the paid seams would make it possible for
 * a publish to start writing.
 */
export function publishTaskDeps(): PublishTaskDeps {
  return { getDb: db, getPool: dbPool, capture: generationCapture() }
}

export function generationTaskDeps(): GenerationTaskDeps {
  return {
    getDb: db,
    getPool: dbPool,
    llm: generationLlm(),
    // The one guarded fetcher: every outbound page read in the product goes
    // through it, so the SSRF protections are not something a caller can
    // forget.
    pageFetcher: new GuardedPageFetcher(),
    seo: generationSeoProvider(),
    claimPlanPrompt: loadPrompt('claim-plan', 1),
    draftPrompt: loadPrompt('draft', 1),
    judgePrompt: loadPrompt('judge', 1),
    contradictionPrompt: loadPrompt('contradiction', 1),
    revisePrompt: loadPrompt('revise', 1),
    // The bell, for the one thing this cycle has to tell a merchant: a draft
    // is waiting for them. Given the factory rather than a handle, for the
    // same reason `getDb` is — nothing opens a connection at registration.
    notifications: new DbNotificationEmitter(db),
    capture: generationCapture(),
  }
}

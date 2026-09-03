import { DataForSeoProvider, MockSeoDataProvider, PosthogServerCapture } from '@sortiva/providers'
import type { SeoDataProvider } from '@sortiva/core'
import { db, PostgresCostLedger, PostgresRequestCache } from '@sortiva/db'
// Deep imports, not the package barrel — `@sortiva/llm`'s default export
// surface is loaded by the server's start-up hook, and pulling a package's
// whole surface into that bundle is how earlier cards broke the build (see
// DECISIONS 2026-09-01 T1.3, and `apps/web/app/api/shopify/_lib/config.ts`,
// which the same reasoning already applies to).
import { AnthropicLlmClient } from '@sortiva/llm/client'
import { loadPrompt } from '@sortiva/llm/prompts'
// Deep import to the file, not the `scan` barrel: `@sortiva/jobs`'s package
// exports map only resolves `./<path>` to `./src/<path>.ts`, and the same
// full-barrel caution as the LLM client above applies to `@sortiva/jobs`
// itself — see `apps/web/app/api/shopify/_lib/config.ts`'s identical note.
import { DbExistingTargetCheck } from '@sortiva/jobs/scan/existing-target'
import type { AddTopicDeps } from './add'
import type { TopicMutationDeps } from './mutations'

/**
 * This card's own process-wide singletons for `/api/calendar/topics`,
 * duplicating the small shape `apps/web/app/api/shopify/_lib/config.ts`
 * already uses for the same three services (an LLM client, a capture, a SEO
 * provider) rather than importing across Lane B's directory — see DECISIONS
 * 2026-09-03 T4.2.
 */

let llm: AnthropicLlmClient | undefined
let capture: PosthogServerCapture | undefined
let seo: SeoDataProvider | undefined

function calendarCapture(): PosthogServerCapture {
  capture ??= new PosthogServerCapture()
  return capture
}

function calendarLlm(): AnthropicLlmClient {
  llm ??= new AnthropicLlmClient({
    cache: new PostgresRequestCache(db()),
    capture: calendarCapture(),
    ledger: new PostgresCostLedger(db()),
  })
  return llm
}

function calendarSeoProvider(): SeoDataProvider {
  if (seo) return seo
  seo =
    process.env.SEO_PROVIDER_MODE === 'mock'
      ? new MockSeoDataProvider({}, calendarCapture())
      : new DataForSeoProvider({
          cache: new PostgresRequestCache(db()),
          capture: calendarCapture(),
          ledger: new PostgresCostLedger(db()),
        })
  return seo
}

export const TOPIC_CLASSIFY_PROMPT_VERSION = 'topic-classify.v1'

export function addTopicDeps(): AddTopicDeps {
  return {
    db: db(),
    llm: calendarLlm(),
    prompt: loadPrompt('topic-classify', 1),
    existingTargetCheck: new DbExistingTargetCheck({ db: db(), seo: calendarSeoProvider() }),
    capture: calendarCapture(),
  }
}

export function topicMutationDeps(): TopicMutationDeps {
  return { db: db() }
}

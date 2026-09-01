import type { LlmClient } from '../contracts/llm'
import type { PosthogCapture } from '../contracts/analytics'

/**
 * `packages/core` holds domain logic and no persistence or I/O (CLAUDE.md code
 * structure), so the preview talks to ports. `apps/web` binds them to Postgres,
 * the guarded fetcher, Turnstile and the instrumented LLM wrapper.
 */

/** One `preview_cache` row. */
export interface PreviewCacheEntry {
  readonly domain: string
  readonly summary: string
  readonly fetchedAt: Date
}

/**
 * Invariant 2 — preview output is disposable. This port has exactly two
 * methods, both used only by the preview module; nothing in ingestion, persona,
 * topic selection or evidence may read it. `disposable.test.ts` enforces that
 * as an import-graph assertion rather than a convention.
 */
export interface PreviewCacheStore {
  read(domain: string): Promise<PreviewCacheEntry | undefined>
  write(entry: PreviewCacheEntry & { expiresAt: Date }): Promise<void>
}

/** What one guarded fetch returns. The structural shape of `PageFetchResult` in `@sortiva/providers`. */
export interface PreviewPage {
  readonly finalUrl: string
  readonly status: number
  readonly contentType: string
  readonly body: string
  readonly bytes: number
}

/** The one guarded HTTP client, as the preview sees it. */
export interface PreviewFetcher {
  fetch(request: {
    url: string
    budget?: { timeoutMs?: number; maxBytes?: number; maxRedirects?: number }
  }): Promise<PreviewPage>
}

/** The bot challenge, verified server-side before any fetch happens. */
export interface PreviewChallenge {
  verify(
    token: string,
    remoteIp?: string,
  ): Promise<{ success: boolean; errorCodes: readonly string[] }>
}

/**
 * The preview spend trip, read from our own `ops_flags` table. Analytics
 * observes a trip; it never causes or gates one.
 */
export interface PreviewKillSwitch {
  isPreviewPaused(): Promise<boolean>
}

/**
 * The versioned prompt text, from `prompts/<name>.v<N>.md`. Supplied by
 * the caller because `packages/llm` owns the loader and `packages/core` cannot
 * depend on it without a cycle.
 */
export interface PreviewPrompt {
  /** e.g. `preview.v1`; stamped on the `$ai_generation` capture. */
  readonly version: string
  readonly text: string
}

export interface PreviewDependencies {
  readonly cache: PreviewCacheStore
  readonly fetcher: PreviewFetcher
  readonly challenge: PreviewChallenge
  readonly flags: PreviewKillSwitch
  readonly llm: LlmClient
  readonly prompt: PreviewPrompt
  readonly capture: Pick<PosthogCapture, 'capture'>
  readonly rateLimiter: { check(ip: string): { allowed: boolean; scope?: string; retryAfterSeconds?: number } }
  readonly scrapeCap: { acquire(): (() => void) | undefined }
  readonly now?: () => Date
}

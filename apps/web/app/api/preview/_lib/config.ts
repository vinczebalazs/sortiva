import { OutboundScrapeCap, PreviewRateLimiter, type PreviewPrompt } from '@sortiva/core'
import { db, PostgresCostLedger, PostgresRequestCache } from '@sortiva/db'
// Deep imports rather than the `@sortiva/llm` barrel, which drags the whole
// package into this bundle. Both of these are small modules with no side
// effects at import.
import { AnthropicLlmClient } from '@sortiva/llm/client'
import { loadPrompt } from '@sortiva/llm/prompts'
import { CloudflareTurnstile, GuardedPageFetcher, PosthogServerCapture } from '@sortiva/providers'
import { OpsFlagPreviewSwitch, PostgresPreviewCache } from './store'

/**
 * The preview's process-wide singletons, all built lazily: no Turnstile secret
 * and no Anthropic key exist in dev, and a module-level client would fail
 * `next build`.
 *
 * The rate limiter and the outbound concurrency cap are **per process** by
 * design: v1 runs as a single service with no Redis. If the app is ever
 * scaled past one instance, both become per-instance and the effective limits
 * multiply by the replica count — see DECISIONS 2026-09-01 T1.3.
 */

let rateLimiter: PreviewRateLimiter | undefined
let scrapeCap: OutboundScrapeCap | undefined
let fetcher: GuardedPageFetcher | undefined
let turnstile: CloudflareTurnstile | undefined
let llm: AnthropicLlmClient | undefined
let capture: PosthogServerCapture | undefined

export function previewRateLimiter(): PreviewRateLimiter {
  rateLimiter ??= new PreviewRateLimiter()
  return rateLimiter
}

export function previewScrapeCap(): OutboundScrapeCap {
  scrapeCap ??= new OutboundScrapeCap()
  return scrapeCap
}

/** The one guarded HTTP client, shared with every later page fetch. */
export function previewFetcher(): GuardedPageFetcher {
  fetcher ??= new GuardedPageFetcher()
  return fetcher
}

export function previewTurnstile(): CloudflareTurnstile {
  turnstile ??= new CloudflareTurnstile()
  return turnstile
}

/** Invariant 25 — the single instrumented wrapper. The preview is a `call_type: preview` call through it. */
export function previewLlm(): AnthropicLlmClient {
  llm ??= new AnthropicLlmClient({
    cache: new PostgresRequestCache(db()),
    capture: previewCapture(),
    // The ledger is a required argument so a paid call cannot be added without
    // recording what it cost. Preview spend has no account behind it, so it is
    // attributed to the target domain and lands under the ledger's system scope.
    ledger: new PostgresCostLedger(db()),
  })
  return llm
}

export function previewCapture(): PosthogServerCapture {
  capture ??= new PosthogServerCapture()
  return capture
}

/**
 * Prompts are versioned files (`prompts/<name>.v<N>.md`) and the version is
 * stamped on every model call, so a stored artefact stays reproducible.
 *
 * Loaded through `@sortiva/llm`'s own loader, like every other prompt in the
 * product. This file used to read the prompt itself, from a file URL built out
 * of this module's own address — and **that is why every public preview
 * answered 500**. The bundler rewrites such a URL into a path inside the build
 * output, where a prompt written for the repository tree does not exist, so the
 * read failed before any vendor was reached. The loader composes its path
 * instead, which is opaque to the bundler; it was changed to do so for exactly
 * this reason, and the switch has been recommended in `DECISIONS.md` since
 * 2026-09-01.
 *
 * The loader reads from the repository tree when it is first asked, which is
 * how the deployment runs today. If `next.config.mjs` ever sets
 * `output: 'standalone'`, the prompts directory needs an
 * `outputFileTracingIncludes` entry, exactly as `signals.config.yaml` already
 * has — it is listed under neither today, and that is the day this breaks
 * again.
 */
export const PREVIEW_PROMPT_VERSION = 'preview.v1'

let prompt: PreviewPrompt | undefined

export function previewPrompt(): PreviewPrompt {
  if (!prompt) {
    const loaded = loadPrompt('preview', 1)
    prompt = { version: loaded.version, text: loaded.text }
  }
  return prompt
}

export function previewCacheStore(): PostgresPreviewCache {
  return new PostgresPreviewCache(db())
}

export function previewKillSwitch(): OpsFlagPreviewSwitch {
  return new OpsFlagPreviewSwitch(db())
}

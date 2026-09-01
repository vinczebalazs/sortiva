import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { OutboundScrapeCap, PreviewRateLimiter, type PreviewPrompt } from '@sortiva/core'
import { db, PostgresRequestCache } from '@sortiva/db'
// Deep import, not the `@sortiva/llm` barrel: the barrel re-exports the prompt
// loader, whose `new URL('../prompts/', import.meta.url)` names a *directory*,
// which webpack cannot resolve — `next build` fails on it. See the note on
// PREVIEW_PROMPT_URL below and DECISIONS 2026-09-01 T1.3.
import { AnthropicLlmClient } from '@sortiva/llm/client'
import { CloudflareTurnstile, GuardedPageFetcher, PosthogServerCapture } from '@sortiva/providers'
import { OpsFlagPreviewSwitch, PostgresPreviewCache } from './store'

/**
 * The preview's process-wide singletons, all built lazily: no Turnstile secret
 * and no Anthropic key exist in dev, and a module-level client would fail
 * `next build`.
 *
 * The rate limiter and the outbound concurrency cap are **per process** by
 * design (tech §2.1: one `app` service, "no Redis in v1"). If the app is ever
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

/** tech §2 — the one SSRF-guarded client, shared with every later page fetch. */
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
  })
  return llm
}

export function previewCapture(): PosthogServerCapture {
  capture ??= new PosthogServerCapture()
  return capture
}

/**
 * main §14.2 — prompts are versioned files (`prompts/<name>.v<N>.md`) and the
 * version is stamped on every `$ai_generation` capture, so a stored artefact
 * stays reproducible.
 *
 * Read here rather than through `@sortiva/llm`'s `loadPrompt`, which cannot be
 * bundled by Next: it composes its path from a directory URL, and webpack
 * resolves `new URL(...)` at build time and fails on a directory. A single
 * literal file URL is the form webpack handles — `packages/rules` already loads
 * `signals.config.yaml` exactly this way. `loadPrompt` needs a one-line change
 * in `packages/llm` before any Next-side card can call it; T1.3 was not
 * permitted to make it. See DECISIONS 2026-09-01 T1.3.
 */
export const PREVIEW_PROMPT_VERSION = 'preview.v1'
export const PREVIEW_PROMPT_URL = new URL(
  '../../../../../../packages/llm/prompts/preview.v1.md',
  import.meta.url,
)

let prompt: PreviewPrompt | undefined

export function previewPrompt(): PreviewPrompt {
  prompt ??= {
    version: PREVIEW_PROMPT_VERSION,
    text: readFileSync(fileURLToPath(PREVIEW_PROMPT_URL), 'utf8'),
  }
  return prompt
}

export function previewCacheStore(): PostgresPreviewCache {
  return new PostgresPreviewCache(db())
}

export function previewKillSwitch(): OpsFlagPreviewSwitch {
  return new OpsFlagPreviewSwitch(db())
}

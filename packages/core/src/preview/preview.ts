import { previewAttribution } from '../contracts/analytics'
import { extractPreviewSignals } from './extract'
import {
  PREVIEW_ABOUT_PATHS,
  PREVIEW_CACHE_TTL_MS,
  PREVIEW_FETCH_BUDGET,
  PREVIEW_MIN_SIGNAL_CHARS,
} from './limits'
import type { PreviewDependencies } from './ports'
import { buildPreviewLlmRequest } from './prompt'
import { aboutUrl, InvalidPreviewUrl, normalisePreviewUrl } from './url'

/**
 * main §3 — the unauthenticated preview, "the lure". A stranger pastes a URL and
 * gets back a short "here's what we understood about your business" card.
 *
 * Two properties of this function matter more than what it returns.
 *
 * **It never dead-ends.** main §3.3: "Failure modes return a graceful generic
 * card ... rather than an error; the funnel must never dead-end." Every way the
 * work can fail below — the site is down, the page is unreadable, the model
 * call fails, the spend trip is on, we are at our outbound concurrency cap —
 * produces the same `generic` card and a 200. Only three things are answered
 * with an error, and none of them is a failure of ours: an unusable URL, a
 * failed anti-bot check, and a rate-limited caller.
 *
 * **Its output is disposable.** Constitution invariant 2, main §3.1: the
 * preview "has no production value and its output must never leak into the real
 * ingestion pipeline". Nothing here writes anywhere but `preview_cache`, and
 * `disposable.test.ts` proves no module outside this directory can reach it.
 *
 * Order of operations, and why:
 *
 *   1. Normalise the URL — free, and everything else needs the domain.
 *   2. Rate limit — local and free, so an abusive caller is refused before we
 *      spend a Cloudflare round trip on them (main §3.2).
 *   3. Turnstile — main §3.2 requires it "verified server-side **before any
 *      fetch happens**", and it gates the cache read too, so the cache cannot
 *      be scraped by a bot that skips the challenge.
 *   4. Cache — main §3.2's primary cost control. "A cache hit skips the scrape
 *      *and* the LLM call entirely."
 *   5. Spend trip — main §14.5. Note it is checked *after* the cache: a tripped
 *      preview still serves cache hits as normal.
 *   6. Fetch, extract, summarise, store.
 */

export interface PreviewInput {
  readonly url: string
  readonly turnstileToken: string
  /** The caller's address, for the per-IP limit and for Turnstile's `remoteip`. */
  readonly clientIp: string
}

export interface PreviewCard {
  readonly domain: string
  /** Null on the generic card; the UI renders main §3.3's copy for that case. */
  readonly summary: string | null
  readonly cacheHit: boolean
  readonly generic: boolean
}

/** Why this card looks the way it does. An ops signal — never rendered to a visitor. */
export type PreviewReason =
  | 'cache'
  | 'summarised'
  | 'preview_paused'
  | 'at_capacity'
  | 'fetch_failed'
  | 'thin_content'
  | 'summary_failed'

export type PreviewResult =
  | { readonly kind: 'served'; readonly card: PreviewCard; readonly reason: PreviewReason }
  | { readonly kind: 'invalid_url'; readonly message: string }
  | { readonly kind: 'challenge_failed'; readonly errorCodes: readonly string[] }
  | {
      readonly kind: 'rate_limited'
      readonly scope: string
      readonly retryAfterSeconds: number
    }

export async function runPreview(
  input: PreviewInput,
  deps: PreviewDependencies,
): Promise<PreviewResult> {
  const now = deps.now ?? (() => new Date())
  const startedAt = Date.now()

  let target: { domain: string; homepageUrl: string }
  try {
    target = normalisePreviewUrl(input.url)
  } catch (error) {
    if (error instanceof InvalidPreviewUrl) return { kind: 'invalid_url', message: error.message }
    throw error
  }
  const { domain } = target
  const attribution = previewAttribution(domain)

  const limit = deps.rateLimiter.check(input.clientIp)
  if (!limit.allowed) {
    return {
      kind: 'rate_limited',
      scope: limit.scope ?? 'ip',
      retryAfterSeconds: limit.retryAfterSeconds ?? 60,
    }
  }

  const challenge = await deps.challenge.verify(input.turnstileToken, input.clientIp)
  if (!challenge.success) {
    return { kind: 'challenge_failed', errorCodes: challenge.errorCodes }
  }

  deps.capture.capture({ event: 'preview_requested', attribution })

  const serve = (
    summary: string | null,
    cacheHit: boolean,
    reason: PreviewReason,
  ): PreviewResult => {
    const card: PreviewCard = { domain, summary, cacheHit, generic: summary === null }
    deps.capture.capture({
      event: 'preview_served',
      attribution,
      // Invariant 26 / main §14.7 privacy note: ids and aggregates only. The
      // summary text and the page content never leave the process.
      properties: {
        cache_hit: cacheHit,
        generic: card.generic,
        reason,
        duration_ms: Date.now() - startedAt,
      },
    })
    return { kind: 'served', card, reason }
  }

  const cached = await deps.cache.read(domain)
  if (cached !== undefined) return serve(cached.summary, true, 'cache')

  // main §14.5 — the trip pauses the endpoint, not the system: cache hits above
  // are already served, and a miss gets the generic card at zero marginal cost.
  if (await deps.flags.isPreviewPaused()) return serve(null, false, 'preview_paused')

  const release = deps.scrapeCap.acquire()
  if (release === undefined) return serve(null, false, 'at_capacity')

  try {
    const page = await fetchQuietly(deps, target.homepageUrl)
    if (page === undefined) return serve(null, false, 'fetch_failed')

    let extraction = extractPreviewSignals(page.body)

    // main §3.3 step 4 — one more fetch, and only if the homepage was thin.
    if (extraction.signalChars < PREVIEW_MIN_SIGNAL_CHARS) {
      for (const path of PREVIEW_ABOUT_PATHS) {
        const about = await fetchQuietly(deps, aboutUrl(domain, path))
        if (about === undefined) continue
        const merged = extractPreviewSignals(about.body)
        const text = `${extraction.text}\n${merged.text}`.trim()
        extraction = {
          signals: { ...extraction.signals, ...merged.signals },
          text,
          signalChars: text.length,
        }
        break
      }
    }

    if (extraction.text.trim() === '') return serve(null, false, 'thin_content')

    const summary = await summariseQuietly(deps, domain, extraction.text)
    if (summary === undefined) return serve(null, false, 'summary_failed')

    const fetchedAt = now()
    await deps.cache.write({
      domain,
      summary,
      fetchedAt,
      expiresAt: new Date(fetchedAt.getTime() + PREVIEW_CACHE_TTL_MS),
    })

    return serve(summary, false, 'summarised')
  } finally {
    release()
  }
}

/**
 * A failed fetch is a generic card, not an exception. The guarded fetcher
 * classifies its own refusals (`PageFetchError.reason`), and every one of them —
 * an SSRF block included — means the same thing to the visitor: we could not
 * read this site.
 */
async function fetchQuietly(
  deps: PreviewDependencies,
  url: string,
): Promise<{ body: string } | undefined> {
  try {
    return await deps.fetcher.fetch({ url, budget: PREVIEW_FETCH_BUDGET })
  } catch {
    return undefined
  }
}

async function summariseQuietly(
  deps: PreviewDependencies,
  domain: string,
  pageText: string,
): Promise<string | undefined> {
  try {
    const result = await deps.llm.complete<string>(
      buildPreviewLlmRequest({ prompt: deps.prompt, domain, pageText }),
    )
    const summary = result.text.trim()
    // An empty or degenerate completion is a failed summary, not a card that
    // says nothing. §14.2's "never parse what we can" applied to prose.
    return summary.length < 20 ? undefined : summary
  } catch {
    return undefined
  }
}

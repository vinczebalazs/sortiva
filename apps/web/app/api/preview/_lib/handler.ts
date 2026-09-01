import {
  previewRequestSchema,
  RATE_LIMITED_CODE,
  runPreview,
  type PreviewDependencies,
  type PreviewResult,
} from '@sortiva/core'
import { TurnstileNotConfigured } from '@sortiva/providers'
import {
  previewCacheStore,
  previewCapture,
  previewFetcher,
  previewKillSwitch,
  previewLlm,
  previewPrompt,
  previewRateLimiter,
  previewScrapeCap,
  previewTurnstile,
} from './config'

/**
 * `POST /api/preview` — the product's only unauthenticated surface, so
 * everything that costs money sits behind the bot challenge, the per-IP rate
 * limits and the 7-day cache.
 *
 * Parse → call core → serialise, and nothing else: the ordering of the checks,
 * the cost controls and the graceful generic card all live in `runPreview`.
 */

export interface PreviewHandlerOptions {
  /** Injected by tests; production builds the wired dependencies below. */
  deps?: PreviewDependencies
}

export function makePreviewHandler(options: PreviewHandlerOptions = {}) {
  return async (request: Request): Promise<Response> => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return error(422, 'invalid_body', 'Expected a JSON body.')
    }

    const parsed = previewRequestSchema.safeParse(body)
    if (!parsed.success) {
      return Response.json(
        {
          error: {
            code: 'invalid_body',
            message: 'Paste your site address and complete the check.',
            details: parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        },
        { status: 422 },
      )
    }

    let deps: PreviewDependencies
    try {
      deps = options.deps ?? wire()
    } catch (cause) {
      if (cause instanceof TurnstileNotConfigured) {
        // An ops failure, not a visitor failure: the anti-bot check is the gate
        // in front of everything that spends money, so we stop rather than
        // serve previews unchecked.
        return error(503, 'preview_unavailable', 'The preview is temporarily unavailable.')
      }
      throw cause
    }

    const result = await runPreview(
      {
        url: parsed.data.url,
        turnstileToken: parsed.data.turnstileToken,
        clientIp: clientIpOf(request),
      },
      deps,
    )

    return serialise(result)
  }
}

function serialise(result: PreviewResult): Response {
  switch (result.kind) {
    case 'served':
      return Response.json(result.card, { status: 200 })
    case 'invalid_url':
      return error(422, 'invalid_url', result.message)
    case 'challenge_failed':
      return error(403, 'turnstile_failed', 'That check did not pass. Please try again.')
    case 'rate_limited':
      return Response.json(
        {
          error: {
            code: RATE_LIMITED_CODE,
            message: 'Too many previews from this address. Try again shortly.',
          },
        },
        { status: 429, headers: { 'retry-after': String(result.retryAfterSeconds) } },
      )
  }
}

/**
 * Railway terminates TLS and proxies to the app, so the socket address is the
 * proxy's. `x-forwarded-for`'s left-most entry is the client as the edge saw it;
 * a spoofed header can only cost the spoofer their own rate-limit bucket, never
 * anyone else's, because the limit is a cost guard and not an authorisation
 * boundary. See DECISIONS 2026-09-01 T1.3.
 */
export function clientIpOf(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  const first = forwarded?.split(',')[0]?.trim()
  if (first) return first
  return request.headers.get('x-real-ip')?.trim() || 'unknown'
}

function wire(): PreviewDependencies {
  return {
    cache: previewCacheStore(),
    fetcher: previewFetcher(),
    challenge: previewTurnstile(),
    flags: previewKillSwitch(),
    llm: previewLlm(),
    prompt: previewPrompt(),
    capture: previewCapture(),
    rateLimiter: previewRateLimiter(),
    scrapeCap: previewScrapeCap(),
  }
}

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status })
}

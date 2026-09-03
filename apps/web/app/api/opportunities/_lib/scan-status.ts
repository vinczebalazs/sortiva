import { listSignalRuns, type AccountScope, type Db, type SignalRunRow } from '@sortiva/db'
import type { AccountHandler } from '../../auth/_lib/session'

/**
 * "Finding your growth opportunities…" (main §6.9; ui §3.8) and tech §1.6's
 * SSE pattern, built the same way `/api/ingestion/status`+`/stream` already
 * are — reusing that exact shape rather than inventing a second one.
 *
 * **What this deliberately does not do.** Ui §3.8 asks for sub-lines that
 * name which stage is running ("Checking pages that already rank…",
 * "Comparing you to competitors…"). `signal_runs` (schema wave 2) is one row
 * per whole pass with no child step table recording which detector is
 * currently running — and this card may not migrate one. `T9.4`'s own
 * DECISIONS entry (2026-09-03) already named this exact gap and the
 * principle that resolves it: a fabricated timer ticking through invented
 * stage names would be untrue on the one screen whose job is to earn trust
 * before the product has produced anything, so nothing here invents stage
 * text. What this route reports is real: whether the account's most recent
 * onboarding run is still running, when it started, and — once finished —
 * the actual counts. Sub-stage copy stays a real, open gap for whoever adds
 * per-detector progress tracking; see DECISIONS 2026-09-03 T3.7.
 */

export interface ScanStatusDeps {
  readonly db: Db
}

const POLL_INTERVAL_MS = 2_000

function serialiseRun(run: SignalRunRow | undefined) {
  if (!run) return { status: 'not_started' as const }
  return {
    runId: run.runId,
    kind: run.kind,
    status: run.finishedAt ? ('finished' as const) : ('running' as const),
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    opportunitiesCreated: run.opportunitiesCreated,
    opportunitiesUpdated: run.opportunitiesUpdated,
    opportunitiesExpired: run.opportunitiesExpired,
  }
}

async function latestOnboardingRun(deps: ScanStatusDeps, scope: AccountScope) {
  const runs = await listSignalRuns(deps.db, scope, 'onboarding')
  return runs[0]
}

/** `GET /api/opportunities/scan-status` — the 2-second fallback poll for when the SSE stream drops. */
export function makeScanStatusHandler(deps: ScanStatusDeps): AccountHandler {
  return async (_request, { scope }) => {
    const run = await latestOnboardingRun(deps, scope)
    return Response.json(serialiseRun(run))
  }
}

/** `GET /api/opportunities/scan-stream` — SSE, closes itself once the run finishes. */
export function makeScanStreamHandler(deps: ScanStatusDeps): AccountHandler {
  return (request, { scope }) => {
    const encoder = new TextEncoder()

    const stream = new ReadableStream({
      start(controller) {
        let closed = false

        const stop = (): void => {
          if (closed) return
          closed = true
          clearInterval(timer)
          try {
            controller.close()
          } catch {
            // Already closed by the client disconnecting.
          }
        }

        const tick = async (): Promise<void> => {
          if (closed) return
          const run = await latestOnboardingRun(deps, scope)
          const body = serialiseRun(run)
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(body)}\n\n`))
          if (body.status !== 'running') stop()
        }

        const timer = setInterval(() => void tick(), POLL_INTERVAL_MS)
        request.signal.addEventListener('abort', stop)
        void tick()
      },
    })

    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' },
    })
  }
}

import { makeIngestionStatusStore, type IngestionRunView, type IngestionStatusStore } from '@sortiva/db'
import { ALL_STEPS } from '@sortiva/jobs/runtime/steps'
import type { AccountHandler } from '../../auth/_lib/session'

/**
 * The ingestion progress stepper (ui §3.2) and its SSE feed (tech §1.6).
 *
 * Both routes read the same one thing — this account's latest onboarding run
 * — and shape it the same way. The status route is the 5-second fallback poll
 * tech §1.6 asks for; the stream route is the SSE endpoint proper, and it
 * reuses the same serialisation so the two can never disagree about what a
 * step's state is called.
 */

/** How often the stream re-reads the run and pushes it, if nothing has told it to look sooner. Not specified anywhere; see `DECISIONS.md`. */
const POLL_INTERVAL_MS = 2_000

export interface IngestionDeps {
  readonly store: IngestionStatusStore
}

export function ingestionDeps(): IngestionDeps {
  return { store: makeIngestionStatusStore() }
}

function badRequest(code: string, message: string, status = 404): Response {
  return Response.json({ error: { code, message } }, { status })
}

/**
 * Steps in pipeline order, not table order — `job_steps` carries no ordinal
 * column, so the dependency graph both drives dispatch and orders the screen.
 */
function orderedSteps(run: IngestionRunView): IngestionRunView['steps'] {
  const rank = new Map(ALL_STEPS.map((step, index) => [step, index]))
  return [...run.steps].sort((a, b) => (rank.get(a.step) ?? 0) - (rank.get(b.step) ?? 0))
}

function serialiseRun(run: IngestionRunView) {
  return {
    jobId: run.jobId,
    status: run.status,
    steps: orderedSteps(run).map((step) => ({
      step: step.step,
      state: step.state,
      startedAt: step.startedAt ? step.startedAt.toISOString() : null,
      updatedAt: step.updatedAt.toISOString(),
      attempts: step.attempts,
    })),
    startedAt: run.startedAt.toISOString(),
  }
}

/** `GET /api/ingestion/status` */
export function makeIngestionStatusHandler(deps: IngestionDeps): AccountHandler {
  return async (_request, { scope }) => {
    const run = await deps.store.latestRun(scope)
    if (!run) return badRequest('no_ingestion_run', 'This account has not started onboarding yet.')
    return Response.json(serialiseRun(run))
  }
}

/**
 * `GET /api/ingestion/stream` — Server-Sent Events, one `data:` line per
 * poll, carrying the same body `/api/ingestion/status` returns.
 *
 * There is no push signal from the worker to this process — a step's
 * transition is a database write, not an event this route is told about — so
 * "streams step transitions" means polling the row on a short interval and
 * forwarding what changed. The interval is well inside what a person notices
 * as live, and it stops on its own: once the run leaves `running`, one last
 * event carries the final state and the stream closes, so a finished run
 * does not hold a connection open forever.
 */
export function makeIngestionStreamHandler(deps: IngestionDeps): AccountHandler {
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
            // Already closed by the client disconnecting; nothing left to do.
          }
        }

        const tick = async (): Promise<void> => {
          if (closed) return
          const run = await deps.store.latestRun(scope)
          if (!run) return
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(serialiseRun(run))}\n\n`))
          if (run.status !== 'running') stop()
        }

        const timer = setInterval(() => void tick(), POLL_INTERVAL_MS)
        request.signal.addEventListener('abort', stop)
        void tick()
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    })
  }
}

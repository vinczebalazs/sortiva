/**
 * The platform sends SIGTERM with a grace period on deploy. The worker drains
 * gracefully, and anything that does not finish in time resumes on its own.
 *
 * `StepContext.signal` is the half of that a long step reads: a loop checks it
 * and returns at its last checkpoint instead of being killed between two pages.
 * This module is the half that produces it. Without a producer the signal never
 * fires, the drain waits for the whole step, Railway kills the process past the
 * grace period, and the step is stranded in `running` — which is the failure the
 * lease in `lease.ts` then has to clean up after the fact.
 *
 * Process-wide by design: the drain is a property of the process, and a step
 * handler reached through Graphile has no other route to it.
 */

let controller = new AbortController()

/** The signal every `runStep` uses unless the caller passes its own. */
export function shutdownSignal(): AbortSignal {
  return controller.signal
}

export function isShuttingDown(): boolean {
  return controller.signal.aborted
}

/**
 * Called by `installSignalHandlers` the moment a termination signal arrives —
 * *before* the drain is awaited, so in-flight steps get the whole grace period
 * to reach a checkpoint rather than being told after the drain has finished.
 */
export function beginShutdown(reason?: string): void {
  if (controller.signal.aborted) return
  controller.abort(new Error(reason ?? 'worker is shutting down'))
}

/**
 * Test-only. A process that has begun shutting down never un-shuts-down; tests
 * that raise a signal on purpose need the next test to start clean.
 */
export function resetShutdown(): void {
  controller = new AbortController()
}

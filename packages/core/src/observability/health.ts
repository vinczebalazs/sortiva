/**
 * **Is this process actually able to do its job?**
 *
 * The platform restarts a container whose health check fails. A check that
 * always answers "fine" therefore does not merely fail to warn anybody — it
 * disables the one automatic recovery the platform offers, because a process
 * that cannot reach its database and a process that is perfectly well look
 * identical from outside.
 *
 * Two things have to be true for this process to be doing its job: it can talk
 * to the database, and the background worker that runs every merchant's
 * pipeline is running. Neither is inferable from the web server answering a
 * request, which is why both are probed rather than assumed.
 *
 * This module holds no infrastructure of its own: the database probe is handed
 * in by the caller, and the worker's state is whatever the worker last recorded
 * here.
 */

/** What the worker last said about itself. */
export type WorkerLiveness =
  /** Started and not since stopped. */
  | { readonly status: 'running'; readonly since: string }
  /**
   * Deliberately not running in this process — local UI work, or the day the
   * worker moves to a service of its own. Healthy: nothing is broken, the work
   * is simply somebody else's.
   */
  | { readonly status: 'not_expected'; readonly reason: string }
  /** It was running and it is not any more. */
  | { readonly status: 'stopped'; readonly reason: string; readonly since: string }
  /** Nothing has ever reported in. The entry point never got that far. */
  | { readonly status: 'never_started' }

/**
 * Kept on `globalThis` rather than in a module variable because the two halves
 * that use it are bundled separately: the startup hook that writes it and the
 * route handler that reads it can end up holding two different copies of this
 * module, and two copies means the reader sees "never started" forever while
 * the worker runs happily. A process has exactly one `globalThis`.
 */
const LIVENESS_KEY = Symbol.for('sortiva.observability.worker-liveness')

type LivenessHolder = { [LIVENESS_KEY]?: WorkerLiveness }

function holder(): LivenessHolder {
  return globalThis as unknown as LivenessHolder
}

export function workerLiveness(): WorkerLiveness {
  return holder()[LIVENESS_KEY] ?? { status: 'never_started' }
}

export function markWorkerRunning(now: Date = new Date()): void {
  holder()[LIVENESS_KEY] = { status: 'running', since: now.toISOString() }
}

/** @param reason why no worker belongs in this process — it is reported as-is. */
export function markWorkerNotExpected(reason: string): void {
  holder()[LIVENESS_KEY] = { status: 'not_expected', reason }
}

/** @param reason a drain, a crash, a failed start — reported as-is so an operator sees which. */
export function markWorkerStopped(reason: string, now: Date = new Date()): void {
  holder()[LIVENESS_KEY] = { status: 'stopped', reason, since: now.toISOString() }
}

/** Test-only: one suite's process-wide state must not leak into the next. */
export function resetWorkerLiveness(): void {
  delete holder()[LIVENESS_KEY]
}

export interface HealthCheck {
  /** `database` or `worker` — stable, so an alert can be written against it. */
  readonly name: string
  readonly ok: boolean
  /** One plain sentence for whoever is reading the failing probe at 3am. */
  readonly detail: string
}

export interface HealthReport {
  readonly ok: boolean
  readonly checks: readonly HealthCheck[]
}

export interface HealthProbes {
  /** Resolves when the database answered; rejects with why it did not. */
  pingDatabase: () => Promise<unknown>
  /** Defaults to what the worker last recorded. Injectable so a test need not drive a real worker. */
  worker?: () => WorkerLiveness
}

export async function checkHealth(probes: HealthProbes): Promise<HealthReport> {
  const checks: HealthCheck[] = [await databaseCheck(probes.pingDatabase), workerCheck((probes.worker ?? workerLiveness)())]
  return { ok: checks.every((check) => check.ok), checks }
}

async function databaseCheck(ping: () => Promise<unknown>): Promise<HealthCheck> {
  try {
    await ping()
    return { name: 'database', ok: true, detail: 'answered' }
  } catch (error) {
    // The message, never the connection string: a Postgres URL carries a
    // password, and this response is served to anyone who can reach the port.
    return {
      name: 'database',
      ok: false,
      detail: error instanceof Error ? error.message : 'the database did not answer',
    }
  }
}

function workerCheck(liveness: WorkerLiveness): HealthCheck {
  switch (liveness.status) {
    case 'running':
      return { name: 'worker', ok: true, detail: `running since ${liveness.since}` }
    case 'not_expected':
      return { name: 'worker', ok: true, detail: `not expected in this process: ${liveness.reason}` }
    case 'stopped':
      return { name: 'worker', ok: false, detail: `stopped at ${liveness.since}: ${liveness.reason}` }
    case 'never_started':
      return {
        name: 'worker',
        ok: false,
        // The startup hook is awaited before the server accepts traffic, so by
        // the time anything can ask this question the worker has either started
        // or failed to.
        detail: 'the worker never reported starting',
      }
  }
}

import type { PosthogCapture } from '@sortiva/core'
import {
  markWorkerNotExpected,
  markWorkerRunning,
  markWorkerStopped,
} from '@sortiva/core/observability/health'
import { CRON_ENTRIES, type CronEntry } from './crontab'
import { killSwitchReaderInstalled } from './gate'
import { registeredTaskNames, taskList } from './tasks'
import { installSignalHandlers, startWorker, type StartedWorker } from './worker'

/**
 * The worker starts alongside the web server in the same process. Called from
 * `apps/web/instrumentation.ts`, which Next runs once per
 * server process on the Node runtime.
 *
 * Two guards, both deliberate:
 *
 *  - `WORKER_ENABLED=false` skips it entirely, for local UI work and for the
 *    day the worker splits into its own Railway service (a start-command change
 *    on the same image).
 *  - A scheduled job whose handler was never registered stops the worker
 *    starting at all.
 *
 * That second guard used to do the opposite, and the difference is the whole
 * point of it. It turned the schedule **off** — all of it, the daily article,
 * the nightly billing reconciliation, the Search Console sync, the sweep that
 * finishes half-done publishes — and wrote one line to the log while the web
 * server went on serving pages perfectly. Nothing about the product looked
 * broken; it simply stopped doing anything on its own. One misspelt name in
 * one entry was enough.
 *
 * It made sense once: through M0 no handlers existed at all, and running with
 * no schedule was better than a crontab pointing at nothing. That stopped being
 * true the moment the first handler landed, and the condition outlived it.
 */

let started: StartedWorker | undefined

export interface BootstrapOptions {
  /**
   * The process's analytics client, built by the entry point's composition root
   * (`@sortiva/core/runtime/services`). **Required, not optional**, so a second
   * worker entry point — the day the worker splits into its own service —
   * cannot start without telemetry by simply not mentioning it.
   * A caller that genuinely wants none names `UnrecordedCapture`, the same
   * opt-out `AnthropicLlmClient` and `DataForSeoProvider` take.
   *
   * The worker needs it for two reasons: to flush the batch on shutdown (below),
   * and to hand to the step handlers lanes will register.
   */
  analytics: PosthogCapture
  connectionString?: string
  logger?: Pick<Console, 'log' | 'error'>
  /**
   * Test seams. The drain ends in `process.exit`, and the signals it listens for
   * are the ones a test runner also listens for, so a test that wants to drive a
   * real drain has to redirect both.
   */
  signals?: readonly NodeJS.Signals[]
  exit?: (code: number) => void
  /**
   * The schedule to insist on. Production never passes it and gets the real
   * one; a test whose subject is not the schedule passes `[]` and starts a
   * worker with no cron at all, which is what it wants anyway.
   */
  cronEntries?: readonly CronEntry[]
}

export async function bootstrapWorker(
  options: BootstrapOptions,
): Promise<StartedWorker | undefined> {
  const logger = options.logger ?? console

  if (process.env.WORKER_ENABLED === 'false') {
    logger.log('[worker] WORKER_ENABLED=false — not starting the in-process worker')
    // Said out loud rather than left as silence, because the health check reads
    // this: silence is "the worker should be here and is not", which fails the
    // check and gets the container restarted. A worker nobody asked for must
    // not look like a worker that died.
    markWorkerNotExpected('WORKER_ENABLED=false')
    return undefined
  }
  if (started) return started

  // Every registered handler is wrapped in the kill-switch check, and that
  // wrapper needs a way to reach the database. Without it, no job would consult
  // the switches and the process would look exactly like a healthy worker.
  // Refusing to start is the loud version of that.
  if (!killSwitchReaderInstalled()) {
    const detail =
      'installKillSwitchReader() was never called, so no job would consult the kill switches'
    markWorkerStopped(`refused to start: ${detail}`)
    throw new Error(`[worker] ${detail}`)
  }

  const entries = options.cronEntries ?? CRON_ENTRIES
  const registered = new Set(registeredTaskNames())
  const missing = entries.map((e) => e.task).filter((task) => !registered.has(task))

  // The same shape as the kill-switch guard above, and for the same reason: a
  // worker that came up missing something it needs is worse than one that did
  // not come up, because only the second is visible.
  if (missing.length > 0) {
    const detail =
      `${missing.length} scheduled job(s) have no registered handler, so nothing would run them: ` +
      missing.join(', ')
    markWorkerStopped(`refused to start: ${detail}`)
    throw new Error(`[worker] ${detail}`)
  }

  try {
    started = await startWorker({
      ...(options.connectionString ? { connectionString: options.connectionString } : {}),
      taskList: taskList(),
      cronEntries: entries,
      // A caller that asked for no schedule gets none. Graphile treats an empty
      // crontab string as "go and find a crontab file", so an empty schedule
      // has to be off rather than blank.
      enableCron: entries.length > 0,
    })
  } catch (error) {
    // A worker that never came up is exactly the state the health check exists
    // to expose: the web server will happily serve pages while no merchant's
    // pipeline moves.
    markWorkerStopped(`failed to start: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }

  markWorkerRunning()

  // The runner's promise settles when it stops for any reason — a drain, or the
  // pool dying under it. Either way the worker is no longer running, and the
  // health check has to be able to say so; a process whose worker died silently
  // is the failure this whole card is about.
  const stopped = (reason: string) => markWorkerStopped(reason)
  void started.runner.promise.then(
    () => stopped('the runner stopped'),
    (error: unknown) => stopped(`the runner exited: ${error instanceof Error ? error.message : String(error)}`),
  )

  installSignalHandlers(started, {
    logger,
    ...(options.signals ? { signals: options.signals } : {}),
    // PostHog batches events and sends them in the background, so the events of
    // the last few seconds before a deploy live only in memory. This empties
    // that batch inside Railway's grace period, after the jobs have drained, so
    // the events a draining step just emitted go too.
    onStopped: () => flushAnalytics(options.analytics, logger),
    exit: options.exit ?? ((code) => process.exit(code)),
  })

  logger.log(
    `[worker] started with ${registered.size} task(s), cron ${entries.length > 0 ? 'enabled' : 'disabled'}`,
  )
  return started
}

/**
 * Sends whatever PostHog has buffered and closes the client. Failures are logged
 * rather than raised: a telemetry flush must never turn a clean drain into a
 * failed one, because the drain is what lets in-flight work finish before
 * the platform kills the process.
 */
export async function flushAnalytics(
  analytics: Pick<PosthogCapture, 'shutdown'>,
  logger: Pick<Console, 'log' | 'error'> = console,
): Promise<void> {
  try {
    await analytics.shutdown()
  } catch (error) {
    logger.error('[worker] flushing analytics on shutdown failed', error)
  }
}

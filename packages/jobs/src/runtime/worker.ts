import { run, type Runner, type TaskList } from 'graphile-worker'
import { assertCrontabTasksExist, crontab, type CronEntry, CRON_ENTRIES } from './crontab'

/**
 * tech §2 / §2.1 — Graphile Worker runs **in-process with the web server** in
 * v1. That is normally frowned on because deploys and crashes kill running
 * jobs; main §14.3 already made that a non-event (every step is resumable,
 * checkpointed and effectively-once) and the §14.3.9 chaos test proves it.
 *
 * Splitting the worker into its own Railway service is a start-command change
 * on the same image — deliberately not taken yet.
 */

export interface WorkerOptions {
  connectionString?: string
  taskList: TaskList
  concurrency?: number
  cronEntries?: readonly CronEntry[]
  /** Off by default so tests can start a worker without a schedule. */
  enableCron?: boolean
  logger?: Pick<Console, 'log' | 'error'>
}

export interface StartedWorker {
  runner: Runner
  /** Drains in-flight jobs, then resolves. Safe to call more than once. */
  stop(): Promise<void>
}

export async function startWorker(options: WorkerOptions): Promise<StartedWorker> {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is not set')

  const entries = options.cronEntries ?? CRON_ENTRIES
  const useCron = options.enableCron ?? true
  if (useCron) {
    assertCrontabTasksExist(Object.keys(options.taskList), entries)
  }

  const runner = await run({
    connectionString,
    // tech §2.1 — sized for the 512 MB app service that also serves requests.
    concurrency: options.concurrency ?? Number(process.env.WORKER_CONCURRENCY ?? 4),
    // We install our own; see installSignalHandlers.
    noHandleSignals: true,
    taskList: options.taskList,
    // A comment line, not an absent key and not an empty string: both are falsy
    // to Graphile, which then hunts for a crontab file on disk and logs a
    // confusing failure when there is none.
    crontab: useCron ? crontab(entries) : '# no scheduled tasks registered yet',
  })

  let stopping: Promise<void> | undefined
  return {
    runner,
    stop() {
      stopping ??= runner.stop()
      return stopping
    },
  }
}

/**
 * tech §2.1 — "Railway sends SIGTERM with a grace period on deploy; Graphile
 * Worker drains gracefully, and anything that doesn't finish resumes
 * idempotently."
 *
 * `runner.stop()` stops accepting new jobs and waits for in-flight ones. We
 * install the handler ourselves (rather than letting Graphile do it) so the
 * process can also close the pool and flush telemetry in the same drain, and so
 * a second signal during a drain does not start a second stop.
 *
 * @returns a function that removes the handlers, for tests.
 */
export function installSignalHandlers(
  worker: Pick<StartedWorker, 'stop'>,
  options: {
    signals?: readonly NodeJS.Signals[]
    onStopped?: () => Promise<void> | void
    exit?: (code: number) => void
    logger?: Pick<Console, 'log' | 'error'>
  } = {},
): () => void {
  const signals = options.signals ?? (['SIGTERM', 'SIGINT'] as const)
  const logger = options.logger ?? console
  let draining = false

  const handler = (signal: NodeJS.Signals) => {
    if (draining) {
      logger.log(`[worker] ${signal} during drain — already stopping, ignoring`)
      return
    }
    draining = true
    logger.log(`[worker] ${signal} received, draining in-flight jobs`)
    void worker
      .stop()
      .then(() => options.onStopped?.())
      .then(() => {
        logger.log('[worker] drained cleanly')
        options.exit?.(0)
      })
      .catch((error: unknown) => {
        logger.error('[worker] drain failed', error)
        options.exit?.(1)
      })
  }

  const bound = signals.map((signal) => {
    const listener = () => handler(signal)
    process.on(signal, listener)
    return [signal, listener] as const
  })

  return () => {
    for (const [signal, listener] of bound) process.off(signal, listener)
  }
}

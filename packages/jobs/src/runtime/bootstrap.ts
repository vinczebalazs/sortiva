import { CRON_ENTRIES } from './crontab'
import { registeredTaskNames, taskList } from './tasks'
import { installSignalHandlers, startWorker, type StartedWorker } from './worker'

/**
 * tech §2.1 — the worker starts alongside the Next.js server in the same
 * process. Called from `apps/web/instrumentation.ts`, which Next runs once per
 * server process on the Node runtime.
 *
 * Two guards, both deliberate:
 *
 *  - `WORKER_ENABLED=false` skips it entirely, for local UI work and for the
 *    day the worker splits into its own Railway service (a start-command change
 *    on the same image).
 *  - Cron is enabled only once every scheduled task in `CRON_ENTRIES` has a
 *    registered handler. Through M0 the registry is empty, so the worker runs
 *    with no schedule rather than with a crontab pointing at nothing. The log
 *    line names what is still missing.
 */

let started: StartedWorker | undefined

export interface BootstrapOptions {
  connectionString?: string
  logger?: Pick<Console, 'log' | 'error'>
}

export async function bootstrapWorker(
  options: BootstrapOptions = {},
): Promise<StartedWorker | undefined> {
  const logger = options.logger ?? console

  if (process.env.WORKER_ENABLED === 'false') {
    logger.log('[worker] WORKER_ENABLED=false — not starting the in-process worker')
    return undefined
  }
  if (started) return started

  const registered = new Set(registeredTaskNames())
  const missing = CRON_ENTRIES.map((e) => e.task).filter((task) => !registered.has(task))
  const enableCron = registered.size > 0 && missing.length === 0

  if (!enableCron) {
    logger.log(
      `[worker] cron disabled — ${missing.length} scheduled task(s) have no handler yet: ${missing.join(', ')}`,
    )
  }

  started = await startWorker({
    ...(options.connectionString ? { connectionString: options.connectionString } : {}),
    taskList: taskList(),
    enableCron,
  })

  installSignalHandlers(started, {
    logger,
    exit: (code) => process.exit(code),
  })

  logger.log(
    `[worker] started with ${registered.size} task(s), cron ${enableCron ? 'enabled' : 'disabled'}`,
  )
  return started
}

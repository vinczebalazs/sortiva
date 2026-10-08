import { run, Logger, type Runner, type TaskList } from 'graphile-worker'

export type WorkerOptions = {
  connectionString: string
  taskList: TaskList
  concurrency?: number
  crontab?: string
  quiet?: boolean
}

export async function startWorker(options: WorkerOptions): Promise<Runner> {
  return run({
    connectionString: options.connectionString,
    taskList: options.taskList,
    concurrency: options.concurrency ?? 4,
    crontab: options.crontab ?? '',
    pollInterval: 200,
    noHandleSignals: true,
    ...(options.quiet ? { logger: new Logger(() => () => {}) } : {}),
  })
}

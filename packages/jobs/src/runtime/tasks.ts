import type { Task, TaskList } from 'graphile-worker'

/**
 * The task registry. Lanes add their Graphile tasks here (one file per step/job
 * per the constitution's code-structure rules) and the crontab in `crontab.ts`
 * refers to them by name.
 *
 * M0 ships it empty on purpose: a crontab entry naming a task nobody registered
 * is a scheduled job that silently never runs, so `startWorker` refuses to
 * enable cron until every scheduled task has a handler. That check is the
 * reason this registry exists rather than a bare object literal at the call
 * site.
 */
const registry = new Map<string, Task>()

export function registerTask(name: string, task: Task): void {
  if (registry.has(name)) {
    throw new Error(`task "${name}" is already registered`)
  }
  registry.set(name, task)
}

export function taskList(): TaskList {
  return Object.fromEntries(registry)
}

export function registeredTaskNames(): string[] {
  return [...registry.keys()]
}

/** Test-only. */
export function clearTasks(): void {
  registry.clear()
}

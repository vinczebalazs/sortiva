import type { Task, TaskList } from 'graphile-worker'
import { guardedTask } from './gate'

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
 *
 * **Registering here is also what puts a job behind the kill switches.** Every
 * handler is wrapped so the switches are read at the moment the job starts;
 * a paused job returns having done nothing, without failing. Doing it here
 * rather than asking each lane to remember is the whole point — a switch that
 * half the code paths consult is not a switch. The short list of jobs that must
 * keep running while the product is paused, and why each one does, is
 * `UNGATED_TASKS` in `gate.ts`.
 */
const registry = new Map<string, Task>()

export function registerTask(name: string, task: Task): void {
  if (registry.has(name)) {
    throw new Error(`task "${name}" is already registered`)
  }
  registry.set(name, guardedTask(name, task as never) as Task)
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

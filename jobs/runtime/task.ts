import type pg from 'pg'
import type { JobHelpers, Task, TaskList } from 'graphile-worker'
import type { Db, DbClient } from '../../db/pool.ts'
import { withStoreLock } from './lock.ts'
import { once } from './ledger.ts'

export type JobContext<P, D> = {
  deps: D
  payload: P
  // The connection holding the store lock; a job's own writes may use it or the pool.
  client: pg.PoolClient
  helpers: JobHelpers
}

export type StoreJob<P, D extends { pool: Db }> = {
  name: string
  storeId: (payload: P) => number
  // null for work that must run every time it is asked, such as a sweep.
  idempotencyKey: (payload: P, deps: D) => string | null
  run: (ctx: JobContext<P, D>) => Promise<unknown>
}

export function defineJob<P, D extends { pool: Db }>(job: StoreJob<P, D>): StoreJob<P, D> {
  return job
}

export function taskList<D extends { pool: Db }>(deps: D, jobs: StoreJob<any, D>[]): TaskList {
  const list: TaskList = {}
  for (const job of jobs) {
    const task: Task = async (raw, helpers) => {
      const payload = raw as never
      const storeId = job.storeId(payload)
      await withStoreLock(deps.pool, storeId, async (client) => {
        const key = job.idempotencyKey(payload, deps)
        const run = () => job.run({ deps, payload, client, helpers })
        if (key === null) return run()
        return (await once(client, { key, storeId, task: job.name }, run)).output
      })
    }
    list[job.name] = task
  }
  return list
}

export async function enqueue(
  db: DbClient,
  name: string,
  payload: unknown,
  options: { jobKey?: string; runAt?: Date; maxAttempts?: number } = {},
): Promise<void> {
  await db.query('select graphile_worker.add_job($1, $2::json, run_at => $3, job_key => $4, max_attempts => $5)', [
    name,
    JSON.stringify(payload),
    options.runAt ?? null,
    options.jobKey ?? null,
    options.maxAttempts ?? 5,
  ])
}

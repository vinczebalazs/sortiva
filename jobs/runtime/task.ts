import type pg from 'pg'
import type { JobHelpers, Task, TaskList } from 'graphile-worker'
import type { Db, DbClient } from '../../db/pool.ts'
import { StorePausedError } from '../../core/status.ts'
import { withStoreLock } from './lock.ts'
import { once } from './ledger.ts'

export type JobContext<P, D> = {
  deps: D
  payload: P
  // The connection holding the store lock; a job's own writes may use it or the pool.
  client: pg.PoolClient
  helpers: JobHelpers
}

type RuntimeDeps = {
  pool: Db
  hooks?: {
    jobStarted?: (storeId: number, task: string) => void | Promise<void>
    jobFinished?: (storeId: number, task: string) => void | Promise<void>
  }
}

export type StoreJob<P, D extends RuntimeDeps> = {
  name: string
  storeId: (payload: P) => number
  // null for work that must run every time it is asked, such as a sweep.
  idempotencyKey: (payload: P, deps: D) => string | null
  run: (ctx: JobContext<P, D>) => Promise<unknown>
}

export function defineJob<P, D extends RuntimeDeps>(job: StoreJob<P, D>): StoreJob<P, D> {
  return job
}

export function taskList<D extends RuntimeDeps>(deps: D, jobs: StoreJob<any, D>[]): TaskList {
  const list: TaskList = {}
  for (const job of jobs) {
    const task: Task = async (raw, helpers) => {
      const payload = raw as never
      const storeId = job.storeId(payload)
      await withStoreLock(deps.pool, storeId, async (client) => {
        const { rows } = await client.query<{ closed: boolean }>('select closed_at is not null as closed from stores where id = $1', [storeId])
        if (rows[0]?.closed) return
        await deps.hooks?.jobStarted?.(storeId, job.name)
        try {
          const key = job.idempotencyKey(payload, deps)
          const run = () => job.run({ deps, payload, client, helpers })
          if (key === null) return await run()
          return (await once(client, { key, storeId, task: job.name }, run)).output
        } catch (error) {
          // A pause is a finished outcome, not a failure: no retry, and nothing recorded, so the work runs again once the pause lifts.
          if (error instanceof StorePausedError) return
          throw error
        } finally {
          await deps.hooks?.jobFinished?.(storeId, job.name)
        }
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
  options: { jobKey?: string; jobKeyMode?: 'replace' | 'preserve_run_at' | 'unsafe_dedupe'; runAt?: Date; maxAttempts?: number } = {},
): Promise<void> {
  await db.query(
    'select graphile_worker.add_job($1, $2::json, run_at => $3, job_key => $4, max_attempts => $5, job_key_mode => $6)',
    [name, JSON.stringify(payload), options.runAt ?? null, options.jobKey ?? null, options.maxAttempts ?? 5, options.jobKeyMode ?? 'replace'],
  )
}

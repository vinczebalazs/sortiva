import type { Runner, TaskList } from 'graphile-worker'
import { createTestDb, type TestDb } from '../db/test-db.ts'
import { startWorker } from '../jobs/worker.ts'

export type Scenario = {
  db: TestDb
  worker: Runner
  /** Resolves once no job is runnable now or locked by a worker. Jobs scheduled for later are left alone. */
  settle: (timeoutMs?: number) => Promise<void>
  stop: () => Promise<void>
}

export async function startScenario(taskList: TaskList, { concurrency = 4 } = {}): Promise<Scenario> {
  const db = await createTestDb()
  const worker = await startWorker({ connectionString: db.url, taskList, concurrency, quiet: true })
  const settle = async (timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const { rows } = await db.pool.query<{ n: number }>(
        `select count(*)::int as n from graphile_worker.jobs
         where (run_at <= now() and attempts < max_attempts) or locked_at is not null`,
      )
      if (rows[0]!.n === 0) return
      if (Date.now() > deadline) throw new Error(`jobs still pending after ${timeoutMs} ms`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  return {
    db,
    worker,
    settle,
    stop: async () => {
      await worker.stop()
      await db.drop()
    },
  }
}

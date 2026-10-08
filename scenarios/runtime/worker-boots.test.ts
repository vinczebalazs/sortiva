import { afterAll, beforeAll, expect, it } from 'vitest'
import { defineJob, enqueue, taskList } from '../../jobs/runtime/task.ts'
import { idempotencyKey } from '../../jobs/runtime/keys.ts'
import type { Db } from '../../db/pool.ts'
import { startScenario, type Scenario } from '../harness.ts'

let s: Scenario
const ran: number[] = []

beforeAll(async () => {
  const deps = { pool: undefined as unknown as Db }
  const ping = defineJob<{ storeId: number }, typeof deps>({
    name: 'ping',
    storeId: (p) => p.storeId,
    idempotencyKey: (p) => idempotencyKey('ping', p.storeId, 'once'),
    run: async ({ payload }) => {
      ran.push(payload.storeId)
      return { pong: payload.storeId }
    },
  })
  s = await startScenario(taskList(deps, [ping]))
  deps.pool = s.db.pool
})
afterAll(() => s?.stop())

it('boots a worker against a real Postgres, runs a store job once and records it in the ledger', async () => {
  const { rows: stores } = await s.db.pool.query<{ id: number }>(`insert into stores (shop_domain) values ('boot.myshopify.com') returning id`)
  const storeId = stores[0]!.id

  await enqueue(s.db.pool, 'ping', { storeId })
  await enqueue(s.db.pool, 'ping', { storeId })
  await s.settle()

  expect(ran).toEqual([storeId])
  const { rows } = await s.db.pool.query('select task, output from job_ledger')
  expect(rows).toEqual([{ task: 'ping', output: { pong: storeId } }])
})

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from '../../db/test-db.ts'
import { once } from './ledger.ts'

let db: TestDb
beforeAll(async () => {
  db = await createTestDb()
})
afterAll(() => db?.drop())

describe('idempotency ledger', () => {
  it('returns the stored output without running again', async () => {
    let runs = 0
    const entry = { key: 'k1', storeId: 1, task: 't' }
    const first = await once(db.pool, entry, async () => ({ n: ++runs }))
    const second = await once(db.pool, entry, async () => ({ n: ++runs }))
    expect(first).toEqual({ output: { n: 1 }, replayed: false })
    expect(second).toEqual({ output: { n: 1 }, replayed: true })
    expect(runs).toBe(1)
  })

  it('runs again when the work failed, because nothing was recorded', async () => {
    const entry = { key: 'k2', storeId: 1, task: 't' }
    await expect(once(db.pool, entry, async () => { throw new Error('vendor down') })).rejects.toThrow()
    expect((await once(db.pool, entry, async () => 'ok')).output).toBe('ok')
  })

  it('keeps the first answer when two runs race to completion', async () => {
    const entry = { key: 'k3', storeId: 1, task: 't' }
    const slow = once(db.pool, entry, async () => { await new Promise((r) => setTimeout(r, 100)); return 'second' })
    const fast = once(db.pool, entry, async () => 'first')
    const [a, b] = await Promise.all([slow, fast])
    expect(a.output).toBe('first')
    expect(b.output).toBe('first')
  })

  it('survives the deletion of the queue rows and of the store itself', async () => {
    const { rows } = await db.pool.query<{ id: number }>(`insert into stores (shop_domain) values ('gone.myshopify.com') returning id`)
    const entry = { key: 'k4', storeId: rows[0]!.id, task: 't' }
    await once(db.pool, entry, async () => 'done')
    await db.pool.query('delete from graphile_worker._private_jobs')
    await db.pool.query('delete from stores where id = $1', [entry.storeId])
    let ran = false
    const again = await once(db.pool, entry, async () => { ran = true; return 'again' })
    expect(ran).toBe(false)
    expect(again.output).toBe('done')
  })
})

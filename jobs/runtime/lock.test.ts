import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from '../../db/test-db.ts'
import { NestedStoreLockError, StoreBusyError, tryWithStoreLock, withStoreLock } from './lock.ts'

let db: TestDb
beforeAll(async () => {
  db = await createTestDb()
})
afterAll(() => db?.drop())

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('per-store lock', () => {
  it('serialises two jobs on one store', async () => {
    const events: string[] = []
    const job = (name: string) =>
      withStoreLock(db.pool, 1, async () => {
        events.push(`${name} start`)
        await sleep(150)
        events.push(`${name} end`)
      })
    await Promise.all([job('a'), job('b')])
    const first = events[0]!.split(' ')[0]
    const second = first === 'a' ? 'b' : 'a'
    expect(events).toEqual([`${first} start`, `${first} end`, `${second} start`, `${second} end`])
  })

  it('runs different stores in parallel', async () => {
    const started = Date.now()
    await Promise.all([1, 2, 3].map((id) => withStoreLock(db.pool, 100 + id, () => sleep(200))))
    expect(Date.now() - started).toBeLessThan(550)
  })

  it('releases the lock when the job throws', async () => {
    await expect(withStoreLock(db.pool, 5, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    const after = await tryWithStoreLock(db.pool, 5, async () => 'free')
    expect(after).toEqual({ ran: true, value: 'free' })
  })

  it('fails loudly rather than waiting forever on a stuck holder', async () => {
    let release!: () => void
    const holder = withStoreLock(db.pool, 6, () => new Promise<void>((r) => { release = r }))
    await sleep(50)
    await expect(withStoreLock(db.pool, 6, async () => 'never', { waitMs: 200 })).rejects.toBeInstanceOf(StoreBusyError)
    release()
    await holder
  })

  it('refuses a nested acquisition of the same store instead of deadlocking', async () => {
    await expect(
      withStoreLock(db.pool, 7, () => withStoreLock(db.pool, 7, async () => 'inner')),
    ).rejects.toBeInstanceOf(NestedStoreLockError)
  })

  it('lets one job hold two different stores', async () => {
    const value = await withStoreLock(db.pool, 8, () => withStoreLock(db.pool, 9, async () => 'both'))
    expect(value).toBe('both')
  })

  it('backs off without queueing when asked not to wait', async () => {
    let release!: () => void
    const holder = withStoreLock(db.pool, 10, () => new Promise<void>((r) => { release = r }))
    await sleep(50)
    expect(await tryWithStoreLock(db.pool, 10, async () => 'x')).toEqual({ ran: false })
    release()
    await holder
  })

  it('does not leak pool connections across many acquisitions', async () => {
    await Promise.all(Array.from({ length: 60 }, (_, i) => withStoreLock(db.pool, 1000 + (i % 5), () => sleep(5))))
    expect(db.pool.totalCount).toBeLessThanOrEqual(20)
    expect(db.pool.waitingCount).toBe(0)
  })
})

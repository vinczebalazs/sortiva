import { AsyncLocalStorage } from 'node:async_hooks'
import type pg from 'pg'
import type { Db } from '../../db/pool.ts'

const STORE_LOCK_NAMESPACE = 0x534f5254

const held = new AsyncLocalStorage<Set<number>>()

export class StoreBusyError extends Error {
  constructor(readonly storeId: number, waitedMs: number) {
    super(`store ${storeId} stayed locked for ${waitedMs} ms; another job is holding it`)
  }
}

export class NestedStoreLockError extends Error {
  constructor(readonly storeId: number) {
    super(`store ${storeId} is already locked by this job; taking it again would wait on itself forever`)
  }
}

export type LockOptions = {
  // How long to queue behind another holder before failing loudly. A stuck holder must not hang the worker.
  waitMs?: number
}

/**
 * Holds a session-level advisory lock on a dedicated connection for the whole of `fn`,
 * so a second job for the same store queues behind this one.
 */
export async function withStoreLock<T>(
  pool: Db,
  storeId: number,
  fn: (client: pg.PoolClient) => Promise<T>,
  { waitMs = 120_000 }: LockOptions = {},
): Promise<T> {
  const mine = held.getStore()
  if (mine?.has(storeId)) throw new NestedStoreLockError(storeId)

  const client = await pool.connect()
  try {
    await client.query(`set lock_timeout = ${Math.max(1, Math.floor(waitMs))}`)
    await client.query('select pg_advisory_lock($1, $2)', [STORE_LOCK_NAMESPACE, storeId])
    await client.query('reset lock_timeout')
  } catch (error) {
    client.release()
    if ((error as { code?: string }).code === '55P03') throw new StoreBusyError(storeId, waitMs)
    throw error
  }

  try {
    return await held.run(new Set([...(mine ?? []), storeId]), () => fn(client))
  } finally {
    try {
      await client.query('select pg_advisory_unlock($1, $2)', [STORE_LOCK_NAMESPACE, storeId])
      client.release()
    } catch {
      // Destroying the connection ends the session, which releases every lock it held.
      client.release(true)
    }
  }
}

/** Returns undefined instead of waiting when the store is busy. */
export async function tryWithStoreLock<T>(pool: Db, storeId: number, fn: (client: pg.PoolClient) => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  if (held.getStore()?.has(storeId)) throw new NestedStoreLockError(storeId)
  const client = await pool.connect()
  let got = false
  try {
    const { rows } = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1, $2) as ok', [STORE_LOCK_NAMESPACE, storeId])
    got = rows[0]!.ok
  } catch (error) {
    client.release()
    throw error
  }
  if (!got) {
    client.release()
    return { ran: false }
  }
  try {
    const value = await held.run(new Set([...(held.getStore() ?? []), storeId]), () => fn(client))
    return { ran: true, value }
  } finally {
    try {
      await client.query('select pg_advisory_unlock($1, $2)', [STORE_LOCK_NAMESPACE, storeId])
      client.release()
    } catch {
      client.release(true)
    }
  }
}

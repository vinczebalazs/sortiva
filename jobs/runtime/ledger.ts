import type { DbClient } from '../../db/pool.ts'

export type LedgerResult<T> = { output: T; replayed: boolean }

/**
 * Runs `fn` at most once to completion per key. A completed key returns its stored output;
 * if two runs race to completion, the first answer recorded is the one everyone gets.
 * Rows are never deleted: losing one would let finished work run again.
 */
export async function once<T>(
  db: DbClient,
  entry: { key: string; storeId: number | null; task: string },
  fn: () => Promise<T>,
): Promise<LedgerResult<T>> {
  const existing = await read<T>(db, entry.key)
  if (existing !== undefined) return { output: existing, replayed: true }

  const output = await fn()
  await db.query(
    `insert into job_ledger (idempotency_key, store_id, task, output) values ($1, $2, $3, $4)
     on conflict (idempotency_key) do nothing`,
    [entry.key, entry.storeId, entry.task, JSON.stringify(output ?? null)],
  )
  return { output: (await read<T>(db, entry.key)) as T, replayed: false }
}

async function read<T>(db: DbClient, key: string): Promise<T | undefined> {
  const { rows } = await db.query<{ output: T }>('select output from job_ledger where idempotency_key = $1', [key])
  return rows[0]?.output
}

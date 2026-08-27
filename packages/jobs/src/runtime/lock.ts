import type pg from 'pg'

/**
 * main §14.3.3 — "All pipeline work for an account serializes through a
 * per-account advisory lock (Postgres `pg_advisory_xact_lock(account_id)` **or
 * equivalent**). This kills an entire class of races cheaply: reconciliation
 * sweep vs. webhook burst vs. user clicking 're-sync' can all enqueue work, but
 * only one mutator touches an account's derived data at a time."
 *
 * We take the "or equivalent" — a **session-level** lock on a dedicated client,
 * not `pg_advisory_xact_lock`. The transaction-scoped form would require holding
 * one transaction open for a whole step, and §14.3.4 requires long steps to
 * commit checkpoints as they go; a checkpoint that is only visible after the
 * step commits is not a checkpoint. Holding the lock on its own connection lets
 * the step body checkpoint on pooled connections while still serialising.
 * See DECISIONS 2026-08-27 T0.4.
 *
 * The lock key is the two-int form: a fixed namespace plus a hash of the account
 * id, so we cannot collide with any other advisory-lock user in the database
 * (Graphile Worker takes advisory locks of its own).
 */

/** Arbitrary but fixed. Any other advisory-lock user in this database uses a different namespace. */
export const ACCOUNT_LOCK_NAMESPACE = 0x5027 // "So" for Sortiva.

async function lockKey(client: pg.PoolClient | pg.Client, accountId: string): Promise<number> {
  const { rows } = await client.query<{ key: number }>('SELECT hashtext($1)::int AS key', [
    accountId,
  ])
  return rows[0]!.key
}

export interface AccountLock {
  readonly accountId: string
  /** The dedicated connection holding the lock. Use the pool for step work. */
  readonly client: pg.PoolClient
  release(): Promise<void>
}

/**
 * Blocks until the lock is available, then runs `fn`. Two workers on the same
 * account serialise; different accounts are fully parallel.
 */
export async function withAccountLock<T>(
  pool: pg.Pool,
  accountId: string,
  fn: (lock: AccountLock) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  const key = await lockKey(client, accountId)
  await client.query('SELECT pg_advisory_lock($1, $2)', [ACCOUNT_LOCK_NAMESPACE, key])

  let released = false
  const release = async () => {
    if (released) return
    released = true
    try {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [ACCOUNT_LOCK_NAMESPACE, key])
    } finally {
      client.release()
    }
  }

  try {
    return await fn({ accountId, client, release })
  } finally {
    await release()
  }
}

/**
 * Non-blocking variant. Returns `undefined` without running `fn` when another
 * worker already holds the account — used where backing off beats queueing
 * (a sweep that will run again in five minutes, say).
 */
export async function tryWithAccountLock<T>(
  pool: pg.Pool,
  accountId: string,
  fn: (lock: AccountLock) => Promise<T>,
): Promise<T | undefined> {
  const client = await pool.connect()
  const key = await lockKey(client, accountId)
  const { rows } = await client.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_lock($1, $2) AS acquired',
    [ACCOUNT_LOCK_NAMESPACE, key],
  )
  if (!rows[0]?.acquired) {
    client.release()
    return undefined
  }

  let released = false
  const release = async () => {
    if (released) return
    released = true
    try {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [ACCOUNT_LOCK_NAMESPACE, key])
    } finally {
      client.release()
    }
  }

  try {
    return await fn({ accountId, client, release })
  } finally {
    await release()
  }
}

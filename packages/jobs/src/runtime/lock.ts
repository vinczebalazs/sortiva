import { AsyncLocalStorage } from 'node:async_hooks'
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
 * The substitution costs three properties the transaction-scoped form gives for
 * free, and this file buys each one back explicitly (DECISIONS 2026-08-31 R1):
 *
 *  - **It cannot be leaked.** Postgres releases a transaction lock at commit or
 *    rollback whatever the client does. A session lock is released only by an
 *    explicit unlock or by the connection dying — so every failure path here
 *    either unlocks or *destroys* the connection, and none returns it to the
 *    pool still holding the lock.
 *  - **It cannot hang a waiter forever.** A bounded `lock_timeout` turns a stuck
 *    holder into a loud, retryable failure on the §14.3.5 backoff.
 *  - **It is re-entrant.** A transaction lock re-taken inside its own
 *    transaction simply succeeds; a second pool connection would wait on the
 *    first forever. The re-entry guard below turns that into a thrown error.
 */

/**
 * Salts the account-id hash so our lock space cannot collide with any other
 * advisory-lock user in this database (Graphile Worker takes locks of its own).
 * Arbitrary but fixed: changing it would let an old and a new process both
 * believe they hold the same account, so it never changes.
 */
export const ACCOUNT_LOCK_NAMESPACE = 0x5027 // "So" for Sortiva.

/**
 * How long a worker waits for another worker to finish with an account before
 * giving up. Long enough to queue behind a `catalog_sync` (§14.3.3's ~8-minute
 * worst case), short enough that a stuck holder surfaces the same hour instead
 * of parking the store silently. Not a spec number — DECISIONS 2026-08-31 R1.
 */
export const ACCOUNT_LOCK_TIMEOUT_MS = 10 * 60_000

/** Postgres cancels a statement that waits past `lock_timeout` with this SQLSTATE. */
const LOCK_NOT_AVAILABLE = '55P03'

/**
 * The wait for an account exceeded `ACCOUNT_LOCK_TIMEOUT_MS`. Carries the two
 * fields `classify()` recognises structurally, so a stuck lock becomes a normal
 * retry on the §14.3.5 backoff rather than an unclassified hang.
 */
export class AccountLockTimeout extends Error {
  readonly retryable = true
  readonly errorClass = 'account_lock_timeout'

  constructor(readonly accountId: string) {
    super(
      `timed out after ${ACCOUNT_LOCK_TIMEOUT_MS}ms waiting for the lock on account ${accountId}: another worker has held it for longer than any step should take`,
    )
    this.name = 'AccountLockTimeout'
  }
}

/**
 * A call stack that already holds an account tried to take it again. Without
 * this the second acquisition waits on a lock its own caller holds and never
 * returns, parking two pool connections with no error anywhere.
 */
export class AccountLockReentry extends Error {
  readonly retryable = false
  readonly errorClass = 'account_lock_reentry'

  constructor(readonly accountId: string) {
    super(
      `this call stack already holds the lock on account ${accountId}; nesting withAccountLock would deadlock. Pass the lock you already hold, or move the inner work outside it.`,
    )
    this.name = 'AccountLockReentry'
  }
}

/**
 * The accounts held by the *current async call stack*, not by the process. That
 * distinction is the point: two sibling jobs for one account in the same process
 * must still queue behind each other through Postgres, while a nested
 * acquisition — the one that can never be satisfied — is caught here.
 */
const held = new AsyncLocalStorage<ReadonlySet<string>>()
const NONE: ReadonlySet<string> = new Set()

function heldAccounts(): ReadonlySet<string> {
  return held.getStore() ?? NONE
}

export function holdsAccountLock(accountId: string): boolean {
  return heldAccounts().has(accountId)
}

export interface AccountLock {
  readonly accountId: string
  /** The dedicated connection holding the lock. Use the pool for step work. */
  readonly client: pg.PoolClient
  release(): Promise<void>
}

export interface AccountLockOptions {
  /** Overridden only where a test needs a stuck lock to fail quickly. */
  timeoutMs?: number
}

/**
 * 64-bit key, in the single-argument advisory-lock space. The previous two-int
 * form gave 32 bits of account hash, in which two unrelated stores collide with
 * near-certainty in the low hundreds of thousands of accounts and quietly
 * serialise behind each other — §14.3.3 promises cross-account work is "fully
 * parallel". `hashtextextended` takes our namespace as its seed, so the
 * namespace survives the move.
 */
async function lockKey(client: pg.PoolClient, accountId: string): Promise<string> {
  // ::text, not a number — an int8 does not survive a round trip through a
  // JavaScript number, and a silently truncated key is a silently shared lock.
  const { rows } = await client.query<{ key: string }>(
    'SELECT hashtextextended($1, $2)::text AS key',
    [accountId, ACCOUNT_LOCK_NAMESPACE],
  )
  return rows[0]!.key
}

/**
 * Builds the release function. Its contract: once it resolves, nobody holds this
 * account's lock, and the connection is either back in the pool clean or
 * destroyed. There is no path that leaves the lock behind.
 */
function makeRelease(client: pg.PoolClient, key: string): () => Promise<void> {
  let released = false
  return async () => {
    if (released) return
    released = true
    try {
      const { rows } = await client.query<{ unlocked: boolean }>(
        'SELECT pg_advisory_unlock($1) AS unlocked',
        [key],
      )
      if (rows[0]?.unlocked === false) {
        // We asked to release a lock this session does not hold. Whatever the
        // cause, this connection's session state is no longer something we can
        // reason about; destroying it is the only way to be sure.
        client.release(new Error('advisory unlock reported the lock was not held'))
        return
      }
      client.release()
    } catch (error) {
      // The unlock itself failed — typically because the step aborted a
      // transaction on this connection, after which Postgres refuses every
      // command on it. Returning it to the pool would hand back a connection
      // that still holds the account's lock, and every future job for that store
      // would then block indefinitely with no error anywhere. A truthy argument
      // destroys the connection instead, and Postgres frees session locks the
      // moment the backend goes away.
      client.release(error as Error)
    }
  }
}

async function acquire(
  pool: pg.Pool,
  accountId: string,
  options: AccountLockOptions,
): Promise<{ client: pg.PoolClient; release: () => Promise<void> }> {
  const client = await pool.connect()
  // Everything from here to a successful acquisition must return the connection
  // on failure. Previously `pool.connect()` sat outside any `try`, so an error
  // in the hash or the acquire leaked one of the ten pool slots shared with the
  // web server — ten such errors take the whole app down.
  let acquired = false
  try {
    const key = await lockKey(client, accountId)
    const timeoutMs = Number(options.timeoutMs ?? ACCOUNT_LOCK_TIMEOUT_MS)
    await client.query(`SET lock_timeout = ${timeoutMs}`)
    try {
      await client.query('SELECT pg_advisory_lock($1)', [key])
      acquired = true
    } catch (error) {
      if ((error as { code?: string }).code === LOCK_NOT_AVAILABLE) {
        throw new AccountLockTimeout(accountId)
      }
      throw error
    }
    // The step body is handed this connection; it must not inherit our wait budget.
    await client.query('RESET lock_timeout')
    return { client, release: makeRelease(client, key) }
  } catch (error) {
    if (acquired) {
      // We hold the lock but cannot hand back a releaser. Destroy the
      // connection so Postgres frees it, rather than pooling one nobody unlocks.
      client.release(error as Error)
    } else {
      client.release()
    }
    throw error
  }
}

/**
 * Blocks until the lock is available, then runs `fn`. Two workers on the same
 * account serialise; different accounts are fully parallel.
 *
 * Throws `AccountLockReentry` when this call stack already holds the account,
 * and `AccountLockTimeout` when the wait exceeds the bounded timeout — the
 * latter retries on the §14.3.5 backoff rather than hanging.
 */
export async function withAccountLock<T>(
  pool: pg.Pool,
  accountId: string,
  fn: (lock: AccountLock) => Promise<T>,
  options: AccountLockOptions = {},
): Promise<T> {
  if (holdsAccountLock(accountId)) throw new AccountLockReentry(accountId)

  const { client, release } = await acquire(pool, accountId, options)
  const nested = new Set([...heldAccounts(), accountId])
  try {
    return await held.run(nested, () => fn({ accountId, client, release }))
  } finally {
    await release()
  }
}

/**
 * Non-blocking variant. Returns `undefined` without running `fn` when another
 * worker already holds the account — used where backing off beats queueing
 * (a sweep that will run again in five minutes, say).
 *
 * A nested acquisition for an account this call stack already holds returns
 * `undefined` too, without touching the pool: to the caller the account is busy,
 * which is exactly true.
 */
export async function tryWithAccountLock<T>(
  pool: pg.Pool,
  accountId: string,
  fn: (lock: AccountLock) => Promise<T>,
): Promise<T | undefined> {
  if (holdsAccountLock(accountId)) return undefined

  const client = await pool.connect()
  let release: () => Promise<void>
  try {
    const key = await lockKey(client, accountId)
    const { rows } = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [key],
    )
    if (!rows[0]?.acquired) {
      client.release()
      return undefined
    }
    release = makeRelease(client, key)
  } catch (error) {
    client.release(error as Error)
    throw error
  }

  const nested = new Set([...heldAccounts(), accountId])
  try {
    return await held.run(nested, () => fn({ accountId, client, release }))
  } finally {
    await release()
  }
}

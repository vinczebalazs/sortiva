import type { AuthSessionStore, AuthUserStore } from './adapter'

/**
 * A test double for the session table: the same five operations, held in a Map.
 *
 * It exists so the sign-in suites can drive the real Auth.js handlers — request
 * in, cookie out, cookie back in — without a Postgres. What those suites are
 * proving is where the *library* ends a session and where it does not, and that
 * is decided inside the library rather than in our SQL. The SQL has its own
 * suite against a real database (`packages/db`).
 *
 * `rows` is exposed so a test can look at what was stored, which is the only way
 * to assert that what we keep is a digest and not the cookie itself. `calls`
 * records every operation in order, which is how a test can hold the product to
 * one lookup and no write per signed-in request.
 */
export interface MemorySessionStore {
  readonly store: AuthSessionStore
  /** Keyed by the digest, exactly as the column is. */
  readonly rows: Map<string, { accountId: string; expires: Date }>
  /** Operation names, in the order they were asked for. */
  readonly calls: string[]
}

export function memorySessionStore(users: AuthUserStore): MemorySessionStore {
  const rows = new Map<string, { accountId: string; expires: Date }>()
  const calls: string[] = []

  const store: AuthSessionStore = {
    async create({ accountId, tokenDigest, expires }) {
      calls.push('create')
      rows.set(tokenDigest, { accountId, expires })
    },
    async findWithAccount(tokenDigest) {
      calls.push('findWithAccount')
      const row = rows.get(tokenDigest)
      if (!row) return undefined
      const account = await users.findById(row.accountId)
      if (!account) return undefined
      return { accountId: row.accountId, email: account.email, expires: row.expires }
    },
    async touch({ tokenDigest, expires }) {
      calls.push('touch')
      const row = rows.get(tokenDigest)
      if (row) rows.set(tokenDigest, { ...row, expires })
    },
    async remove(tokenDigest) {
      calls.push('remove')
      const row = rows.get(tokenDigest)
      if (!row) return undefined
      rows.delete(tokenDigest)
      return row
    },
    async removeAllForAccount(accountId) {
      calls.push('removeAllForAccount')
      let ended = 0
      for (const [digest, row] of [...rows]) {
        if (row.accountId === accountId) {
          rows.delete(digest)
          ended += 1
        }
      }
      return ended
    },
  }

  return { store, rows, calls }
}

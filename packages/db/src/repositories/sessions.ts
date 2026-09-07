import { eq } from 'drizzle-orm'
import type { Db } from '../client'
import { accounts, sessions } from '../schema'
import type { AccountScope, SystemScope } from '../scope'

/**
 * One row per signed-in browser. Ending a session is deleting its row, so these
 * are the only four operations there are.
 *
 * **Nothing here ever sees the value a browser holds.** The column stores a
 * digest of it, computed by the caller before it gets this far, and every
 * parameter below is named `tokenDigest` to say so. That is what stops a copy of
 * this table from being a set of working sessions.
 *
 * The lookup takes a `SystemScope` rather than an `AccountScope` because it is
 * the read that *establishes* which account the request belongs to — there is no
 * account to scope it by until it has answered. Every other operation here knows
 * the account and is scoped to it.
 */

export type SessionRow = typeof sessions.$inferSelect

export const SESSION_LOOKUP_REASON =
  'a session lookup is what identifies the account, so it cannot be scoped by one'

export interface SessionWithAccount {
  readonly tokenDigest: string
  readonly accountId: string
  readonly email: string
  readonly expires: Date
}

export async function createSession(
  db: Db,
  scope: AccountScope,
  input: { tokenDigest: string; expires: Date },
): Promise<SessionRow> {
  const [row] = await db
    .insert(sessions)
    .values({
      sessionToken: input.tokenDigest,
      accountId: scope.accountId,
      expires: input.expires,
    })
    .returning()
  if (!row) throw new Error('session insert returned no row')
  return row
}

/**
 * The read that runs on every signed-in request, and the whole cost of being
 * able to revoke.
 *
 * One statement, joining the account in rather than fetching it separately: the
 * caller needs both and two round trips would double the only cost this feature
 * has. The join is on the primary key of `accounts` from an index probe on the
 * primary key of `sessions`.
 */
export async function findSessionWithAccount(
  db: Db,
  _scope: SystemScope,
  tokenDigest: string,
): Promise<SessionWithAccount | undefined> {
  const [row] = await db
    .select({
      tokenDigest: sessions.sessionToken,
      accountId: sessions.accountId,
      email: accounts.email,
      expires: sessions.expires,
    })
    .from(sessions)
    .innerJoin(accounts, eq(accounts.id, sessions.accountId))
    .where(eq(sessions.sessionToken, tokenDigest))
    .limit(1)
  return row
}

/** Pushes one session's own lapse date out. Never called while sessions have a fixed lifetime. */
export async function touchSession(
  db: Db,
  _scope: SystemScope,
  input: { tokenDigest: string; expires: Date },
): Promise<SessionRow | undefined> {
  const [row] = await db
    .update(sessions)
    .set({ expires: input.expires })
    .where(eq(sessions.sessionToken, input.tokenDigest))
    .returning()
  return row
}

/**
 * Ends one session. Returns the row that was ended, so the caller knows whose
 * it was without reading it first — which is how signing out in one browser
 * finds the account whose other sessions it also has to end.
 */
export async function deleteSession(
  db: Db,
  _scope: SystemScope,
  tokenDigest: string,
): Promise<SessionRow | undefined> {
  const [row] = await db
    .delete(sessions)
    .where(eq(sessions.sessionToken, tokenDigest))
    .returning()
  return row
}

/**
 * Ends every session an account has. This is "sign out everywhere", and it is
 * also what a deleted account and a compromised credential both need.
 *
 * Returns how many were ended, which is the only way a caller can tell the
 * difference between "nothing to revoke" and "revoked".
 */
export async function deleteSessionsForAccount(db: Db, scope: AccountScope): Promise<number> {
  const rows = await db
    .delete(sessions)
    .where(eq(sessions.accountId, scope.accountId))
    .returning({ tokenDigest: sessions.sessionToken })
  return rows.length
}

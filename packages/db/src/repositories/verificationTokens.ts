import { and, eq } from 'drizzle-orm'
import type { Db } from '../client'
import { verificationTokens } from '../schema'
import type { SystemScope } from '../scope'

export type VerificationTokenRow = typeof verificationTokens.$inferSelect

/**
 * One row per outstanding email sign-in link.
 *
 * These rows exist before the account does — the address a link was sent to may
 * belong to nobody yet — so they take a `SystemScope` with a written reason
 * rather than an `AccountScope`.
 */

export async function createVerificationToken(
  db: Db,
  _scope: SystemScope,
  input: { identifier: string; token: string; expires: Date },
): Promise<VerificationTokenRow> {
  const [row] = await db.insert(verificationTokens).values(input).returning()
  if (!row) throw new Error('verification token insert returned no row')
  return row
}

/**
 * Spends a link: the row is read and deleted in one statement, and that is the
 * whole single-use guarantee.
 *
 * `DELETE … RETURNING` is atomic, so of two requests racing on the same link —
 * a double-clicked button, or a mail scanner prefetching the URL a moment
 * before the human clicks it — exactly one gets the row and the other gets
 * nothing. A read followed by a delete would hand the row to both.
 *
 * Expiry is deliberately not checked here. The caller (Auth.js) compares
 * `expires` itself and reports an expired link differently from an unknown one;
 * returning the row and letting it decide keeps one authority over that
 * message, and the row is spent either way.
 */
export async function useVerificationToken(
  db: Db,
  _scope: SystemScope,
  input: { identifier: string; token: string },
): Promise<VerificationTokenRow | undefined> {
  const [row] = await db
    .delete(verificationTokens)
    .where(
      and(
        eq(verificationTokens.identifier, input.identifier),
        eq(verificationTokens.token, input.token),
      ),
    )
    .returning()
  return row
}

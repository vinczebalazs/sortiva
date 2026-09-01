import { and, eq } from 'drizzle-orm'
import type { Db } from '../client'
import { domains } from '../schema'
import type { AccountScope } from '../scope'

export type DomainRow = typeof domains.$inferSelect

/**
 * The claim is an insert-with-conflict, never a check followed by an insert:
 * the unique index on `domain_normalized` decides the winner, so two concurrent
 * claims cannot both succeed no matter how the requests interleave.
 *
 * `domainNormalized` must already be normalised. Normalisation
 * itself is `packages/core`'s job (T1.4); this layer stores what it is given.
 */
/**
 * Inserts one domain row, relying on the unique index to reject a second claim.
 *
 * This is NOT how a merchant claims a domain. The sanctioned path is
 * `claimDomain` in `packages/core/src/domain/claim.ts`, which runs inside one
 * transaction, reads the conflicting row back so it can say *which* of the four
 * outcomes happened, and creates the ingestion run alongside the claim. This
 * function does none of that: it returns undefined for every kind of conflict.
 *
 * It survives because the constraint tests need a minimal writer to prove the
 * unique index itself fires, and because the compile-time scope proof uses it as
 * its example. Do not call it from product code.
 */
export async function insertDomainRow(
  db: Db,
  scope: AccountScope,
  domainNormalized: string,
): Promise<DomainRow | undefined> {
  const [row] = await db
    .insert(domains)
    .values({ accountId: scope.accountId, domainNormalized })
    .onConflictDoNothing()
    .returning()
  return row
}

export async function findDomainForAccount(
  db: Db,
  scope: AccountScope,
): Promise<DomainRow | undefined> {
  const [row] = await db.select().from(domains).where(eq(domains.accountId, scope.accountId)).limit(1)
  return row
}

/**
 * A guarded update. Returns undefined when the guard matched no rows, which the
 * caller must treat as "someone else owns this transition" and stop — never as
 * a retryable failure.
 */
export async function transitionDomainState(
  db: Db,
  scope: AccountScope,
  from: DomainRow['state'],
  to: DomainRow['state'],
): Promise<DomainRow | undefined> {
  const [row] = await db
    .update(domains)
    .set({ state: to, updatedAt: new Date() })
    .where(and(eq(domains.accountId, scope.accountId), eq(domains.state, from)))
    .returning()
  return row
}

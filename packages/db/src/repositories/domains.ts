import { and, eq } from 'drizzle-orm'
import type { Db } from '../client'
import { domains } from '../schema'
import type { AccountScope } from '../scope'

export type DomainRow = typeof domains.$inferSelect

/**
 * main §5, §2 invariants 1–2; constitution invariant 1.
 *
 * "Claim is an insert-with-conflict, never check-then-insert" — the unique
 * index on `domain_normalized` decides the winner, so two concurrent claims
 * cannot both succeed no matter how the requests interleave.
 *
 * `domainNormalized` must already be PSL-normalised (main §2). Normalisation
 * itself is `packages/core`'s job (T1.4); this layer stores what it is given.
 */
export async function claimDomain(
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
 * main §14.3.1 — a guarded update. Returns undefined when the guard matched no
 * rows, which the caller must treat as "someone else owns this transition"
 * (invariant 15), not as a retryable failure.
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

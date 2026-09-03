import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../client'
import { domains } from '../schema'
import type { AccountScope, SystemScope } from '../scope'

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
  from: DomainRow['state'] | readonly DomainRow['state'][],
  to: DomainRow['state'],
): Promise<DomainRow | undefined> {
  const expected = Array.isArray(from) ? [...from] : [from as DomainRow['state']]
  const [row] = await db
    .update(domains)
    .set({ state: to, updatedAt: new Date() })
    .where(and(eq(domains.accountId, scope.accountId), inArray(domains.state, expected)))
    .returning()
  return row
}

/**
 * Every confirmed account, for the onboarding-run sweep to poll.
 *
 * `confirmProfile` (main §6.8) moves a domain to `ready_for_planning` and
 * ends onboarding; the Opportunity Engine's own onboarding run (main §6.9) is
 * a separate, later card's trigger point — `T2.1`'s and `T2.7`'s own
 * DECISIONS entries (2026-09-02/-03) named this exact seam as unwired and
 * left it for whoever builds `T3.7` to close. Reaching into
 * `confirmProfile` itself (`packages/core/src/persona/confirm.ts`) or its
 * route (`apps/web/app/api/profile/confirm`) would mean touching Lane
 * A/B's directories for a callback port that does not exist; a sweep that
 * polls this state, the same shape every other "start the next thing" wiring
 * in this codebase already uses (the monthly-summary sweep, the OAuth and
 * export-URL reminders), stays inside Lane C's own directories instead. No
 * domain ever leaves `ready_for_planning` (the enum has no later state), so
 * the caller tells a first sighting from a repeat one by checking
 * `signal_runs` for an already-finished `onboarding` row, not from this list.
 */
export async function accountsReadyForPlanning(db: Db, _scope: SystemScope): Promise<string[]> {
  const rows = await db
    .select({ accountId: domains.accountId })
    .from(domains)
    .where(eq(domains.state, 'ready_for_planning'))
  return rows.map((row) => row.accountId)
}

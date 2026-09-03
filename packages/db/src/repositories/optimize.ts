import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { opportunities, opportunityTasks, optimizeRecommendations } from '../schema'
import type { AccountScope } from '../scope'
import type { OpportunityTaskRow } from './opportunities'

/**
 * Storage for the advice we generate about a merchant's own pages.
 *
 * `optimize_recommendations` has no `account_id` of its own — it hangs off the
 * opportunity, which has one. Every read and write here therefore joins to
 * `opportunities` and names the account there, so a recommendation can only be
 * reached through an opportunity the caller's account owns. The scope
 * parameter is not decoration: without the join a recommendation id from
 * another store would resolve.
 */

export type OptimizeRecommendationRow = typeof optimizeRecommendations.$inferSelect

export interface OptimizeRecommendationWrite {
  readonly opportunityId: string
  readonly pageUrl: string
  readonly recommendationJson: unknown
  readonly judgeScoresJson: unknown | null
  readonly promptVersion: string
  readonly modelId: string
  readonly rulesVersion: string
  readonly state: OptimizeRecommendationRow['state']
}

/** One task the merchant can mark applied on its own — main §10.4. */
export interface OptimizeTaskWrite {
  readonly kind: OpportunityTaskRow['kind']
  readonly description: string
  readonly suggestedCopyRef: string | null
  readonly evidenceRefs: readonly string[]
}

async function ownsOpportunity(db: Db, scope: AccountScope, opportunityId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(and(eq(opportunities.id, opportunityId), eq(opportunities.accountId, scope.accountId)))
    .limit(1)
  return row !== undefined
}

/**
 * Writes the new recommendation and retires whatever stood before it, in one
 * transaction.
 *
 * Supersession rather than replacement, because the older one is the record of
 * what we told this merchant at the time — a recommendation they may already
 * have half applied. `optimize_recommendations.state` carries which is current;
 * nothing is ever deleted.
 */
export async function storeOptimizeRecommendation(
  db: Db,
  scope: AccountScope,
  input: OptimizeRecommendationWrite,
  tasks: readonly OptimizeTaskWrite[] = [],
): Promise<OptimizeRecommendationRow | undefined> {
  if (!(await ownsOpportunity(db, scope, input.opportunityId))) return undefined

  return db.transaction(async (tx) => {
    await tx
      .update(optimizeRecommendations)
      .set({ state: 'superseded' })
      .where(
        and(
          eq(optimizeRecommendations.opportunityId, input.opportunityId),
          inArray(optimizeRecommendations.state, ['valid', 'failed_validation']),
        ),
      )

    const [row] = await tx
      .insert(optimizeRecommendations)
      .values({
        opportunityId: input.opportunityId,
        pageUrl: input.pageUrl,
        recommendationJson: input.recommendationJson,
        judgeScoresJson: input.judgeScoresJson ?? null,
        promptVersion: input.promptVersion,
        modelId: input.modelId,
        rulesVersion: input.rulesVersion,
        state: input.state,
      })
      .returning()

    if (tasks.length > 0) {
      // The old recommendation's tasks go with it: they describe copy that is
      // no longer what we are suggesting, and leaving them would let a
      // merchant mark applied something we have withdrawn.
      await tx.delete(opportunityTasks).where(eq(opportunityTasks.opportunityId, input.opportunityId))
      await tx.insert(opportunityTasks).values(
        tasks.map((task) => ({
          opportunityId: input.opportunityId,
          kind: task.kind,
          description: task.description,
          suggestedCopyRef: task.suggestedCopyRef,
          evidenceRefs: [...task.evidenceRefs],
        })),
      )
    }

    return row
  })
}

/** The recommendation currently standing for this opportunity, whatever state it is in. */
export async function latestOptimizeRecommendation(
  db: Db,
  scope: AccountScope,
  opportunityId: string,
): Promise<OptimizeRecommendationRow | undefined> {
  const [row] = await db
    .select({ recommendation: optimizeRecommendations })
    .from(optimizeRecommendations)
    .innerJoin(opportunities, eq(optimizeRecommendations.opportunityId, opportunities.id))
    .where(
      and(
        eq(opportunities.accountId, scope.accountId),
        eq(optimizeRecommendations.opportunityId, opportunityId),
        inArray(optimizeRecommendations.state, ['valid', 'failed_validation']),
      ),
    )
    .orderBy(desc(optimizeRecommendations.generatedAt))
    .limit(1)
  return row?.recommendation
}

export interface OptimizeRecommendationWithOpportunity {
  readonly recommendation: OptimizeRecommendationRow
  readonly opportunity: typeof opportunities.$inferSelect
}

export async function findOptimizeRecommendation(
  db: Db,
  scope: AccountScope,
  id: string,
): Promise<OptimizeRecommendationWithOpportunity | undefined> {
  const [row] = await db
    .select({ recommendation: optimizeRecommendations, opportunity: opportunities })
    .from(optimizeRecommendations)
    .innerJoin(opportunities, eq(optimizeRecommendations.opportunityId, opportunities.id))
    .where(and(eq(optimizeRecommendations.id, id), eq(opportunities.accountId, scope.accountId)))
    .limit(1)
  return row
}

export async function listOptimizeTasks(
  db: Db,
  scope: AccountScope,
  opportunityId: string,
): Promise<OpportunityTaskRow[]> {
  const rows = await db
    .select({ task: opportunityTasks })
    .from(opportunityTasks)
    .innerJoin(opportunities, eq(opportunityTasks.opportunityId, opportunities.id))
    .where(
      and(eq(opportunities.accountId, scope.accountId), eq(opportunityTasks.opportunityId, opportunityId)),
    )
    .orderBy(opportunityTasks.kind)
  return rows.map((row) => row.task)
}

/**
 * One task marked applied or skipped. Guarded on the task still being open, so
 * two tabs cannot both claim to have been the one that changed it.
 */
export async function markOptimizeTask(
  db: Db,
  scope: AccountScope,
  input: { readonly taskId: string; readonly state: 'applied' | 'skipped' },
  now: Date = new Date(),
): Promise<OpportunityTaskRow | undefined> {
  const owned = await db
    .select({ id: opportunityTasks.id })
    .from(opportunityTasks)
    .innerJoin(opportunities, eq(opportunityTasks.opportunityId, opportunities.id))
    .where(and(eq(opportunityTasks.id, input.taskId), eq(opportunities.accountId, scope.accountId)))
    .limit(1)
  if (owned.length === 0) return undefined

  const [row] = await db
    .update(opportunityTasks)
    .set({ state: input.state, appliedAt: input.state === 'applied' ? now : null })
    .where(and(eq(opportunityTasks.id, input.taskId), eq(opportunityTasks.state, 'open')))
    .returning()
  return row
}

/**
 * The merchant says they applied it: the opportunity completes and the moment
 * is stamped, which is what the 28-day outcome measurement is counted from.
 *
 * Guarded on the row still being open. A zero-row answer means somebody else
 * moved it — the scan expired it, another tab completed it — and the caller
 * stops rather than re-stamping a decision it did not make.
 */
export async function markOpportunityApplied(
  db: Db,
  scope: AccountScope,
  opportunityId: string,
  now: Date = new Date(),
): Promise<typeof opportunities.$inferSelect | undefined> {
  const [row] = await db
    .update(opportunities)
    .set({ status: 'completed', appliedAt: now, updatedAt: now })
    .where(
      and(
        eq(opportunities.id, opportunityId),
        eq(opportunities.accountId, scope.accountId),
        inArray(opportunities.status, ['new', 'accepted', 'scheduled', 'executing', 'blocked']),
      ),
    )
    .returning()
  return row
}

/**
 * How many OPTIMIZE generations this account has spent today — what the daily
 * cap of main §10.2 is counted against.
 *
 * Two things are counted, and both have to be, for opposite reasons.
 * **Recommendations written since `since`**: the generations that finished,
 * including the ones that failed their checks, because a failed generation
 * still cost the model call the cap exists to limit. **Opportunities currently
 * `executing`**: a generation asked for a minute ago has written no row yet,
 * and without this a merchant clicking twice quickly would be over the cap
 * before either finished.
 *
 * Deliberately not model calls: one generation may make a second call when the
 * first output fails a lint, and charging a merchant's allowance for our own
 * re-ask would take a day's allowance away over our mistake.
 */
export async function countOptimizeGenerationsSince(
  db: Db,
  scope: AccountScope,
  since: Date,
): Promise<number> {
  const [written] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(optimizeRecommendations)
    .innerJoin(opportunities, eq(optimizeRecommendations.opportunityId, opportunities.id))
    .where(
      and(
        eq(opportunities.accountId, scope.accountId),
        sql`${optimizeRecommendations.generatedAt} >= ${since.toISOString()}`,
      ),
    )

  const [running] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(opportunities)
    .where(
      and(
        eq(opportunities.accountId, scope.accountId),
        eq(opportunities.status, 'executing'),
        eq(opportunities.recommendedAction, 'optimize'),
      ),
    )

  return (written?.n ?? 0) + (running?.n ?? 0)
}

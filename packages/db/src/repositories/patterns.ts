import { and, eq, gte } from 'drizzle-orm'
import type { Db } from '../client'
import { patternStats } from '../schema'
import type { AccountScope } from '../scope'

export type PatternStatRow = typeof patternStats.$inferSelect

/**
 * What this store has learned about which kinds of article work for it: one
 * row per axis-value (an intent class, a product family, a keyword cluster, an
 * action type), holding how many rated articles sit behind it and the
 * multiplier they earn.
 *
 * A row only counts once enough rated articles support it — below that it is
 * one lucky post, not a pattern — so the minimum is a parameter the caller
 * reads from `packages/rules` rather than a number written here.
 *
 * **Nothing writes this table yet.** The job that would (the weekly label
 * recompute) is `T7.1`, and M7 is deferred out of v1, so in production this
 * read returns nothing and every candidate scores on its own merits with a
 * multiplier of one. That is the honest state of it, not a placeholder: the
 * read is real, the writer is absent, and the planner behaves correctly with
 * an empty table.
 *
 * The 90-day recency window main §9.6.3 describes belongs to whoever writes
 * these rows — the table holds a recomputed current picture, not history, so
 * there is nothing here to filter by age.
 */
export async function activePatternStats(
  db: Db,
  scope: AccountScope,
  minRated: number,
): Promise<PatternStatRow[]> {
  return db
    .select()
    .from(patternStats)
    .where(and(eq(patternStats.accountId, scope.accountId), gte(patternStats.ratedN, minRated)))
}

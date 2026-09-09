import type { LabelledArticle, PatternAxis, PatternStatRecord } from '@sortiva/core'
import { and, eq, gte, inArray } from 'drizzle-orm'
import type { Db } from '../client'
import { articles, opportunities, patternStats, topics } from '../schema'
import type { AccountScope } from '../scope'
import { ratedArticleLabels } from './labels'

export type PatternStatRow = Omit<typeof patternStats.$inferSelect, 'dimension'> & {
  readonly dimension: string
}

/**
 * The axis `packages/rules` calls `family_id` is spelled `family` in the
 * database.
 *
 * The `pattern_dimension` enum was created in schema wave 3 as `family`; the
 * rules config names the same axis `family_id`, and so does the candidate side
 * of the multiplier lookup in `packages/jobs/generation/replenish.ts`. Nothing
 * noticed while the table was empty — a row that never existed cannot fail to
 * match — and it would have started mattering the moment this card wrote one:
 * a family pattern stored under a name no reader asks for influences nothing,
 * silently.
 *
 * A migration is the real fix, and migrations land only in schema-wave cards,
 * so the two spellings are reconciled here instead — in the only file that both
 * writes and reads the column. Everything outside it speaks the config name.
 * Recorded in `DECISIONS.md` for the next wave.
 */
const STORED_DIMENSION: Readonly<Record<string, string>> = { family_id: 'family' }
const CONFIG_DIMENSION: Readonly<Record<string, string>> = { family: 'family_id' }

type StoredDimension = (typeof patternStats.$inferInsert)['dimension']

function toStored(dimension: string): StoredDimension {
  return (STORED_DIMENSION[dimension] ?? dimension) as StoredDimension
}

function toConfig(dimension: string): string {
  return CONFIG_DIMENSION[dimension] ?? dimension
}

/**
 * What this store has learned about which kinds of article work for it: one
 * row per axis-value (an intent class, a product family, a keyword cluster, an
 * action type), holding how many rated articles sit behind it and the
 * multiplier they earn.
 *
 * A row only counts once enough rated articles support it — below that it is
 * one lucky post, not a pattern — so the minimum is a parameter the caller
 * reads from `packages/rules` rather than a number written here. The writer
 * below declines to store a sub-threshold group at all, so this filter is now a
 * second lock on a door already shut rather than the only one.
 *
 * The 90-day recency window main §9.6.3 describes belongs to the writer: the
 * table holds a recomputed current picture, not history, so there is nothing
 * here to filter by age.
 */
export async function activePatternStats(
  db: Db,
  scope: AccountScope,
  minRated: number,
): Promise<PatternStatRow[]> {
  const rows = await db
    .select()
    .from(patternStats)
    .where(and(eq(patternStats.accountId, scope.accountId), gte(patternStats.ratedN, minRated)))

  return rows.map((row) => ({ ...row, dimension: toConfig(row.dimension) }))
}

/**
 * The verdicts pattern learning may aggregate, each with the axes it counts
 * towards.
 *
 * **Built on `ratedArticleLabels` rather than beside it, and that is the whole
 * design.** Which articles may teach the planner anything is settled in one
 * place: an article the merchant published over our quality objection is
 * `unrated`, and `ratedArticleLabels` is the read that drops `unrated`. Taking
 * its output as the list of articles to fetch axes for means this read cannot
 * reach an article that read refused — not because it re-checks the override
 * flag, but because it never learns such an article's id. Widening what may
 * move a multiplier would take editing that one function.
 *
 * The axes come from the topic the article was written from, which records the
 * lineage at creation (main §9.6.3), plus the action type of the opportunity
 * that topic came from. An article whose topic names no keyword cluster carries
 * no cluster axis rather than an empty one.
 *
 * One entry per stored verdict, not per article: an article judged every week
 * for three months arrives here a dozen times over. Collapsing those to one
 * vote is the aggregation's job, and it needs the windows to know which verdict
 * is the current one.
 */
export async function patternLearningInputs(
  db: Db,
  scope: AccountScope,
  since: Date,
): Promise<LabelledArticle[]> {
  const rated = await ratedArticleLabels(db, scope, since)
  if (rated.length === 0) return []

  const ids = [...new Set(rated.map((row) => row.articleId))]
  const lineage = await db
    .select({
      articleId: articles.id,
      intentClass: topics.intentClass,
      familyIds: topics.familyIds,
      keywordCluster: topics.keywordCluster,
      recommendedAction: opportunities.recommendedAction,
    })
    .from(articles)
    .innerJoin(topics, eq(topics.id, articles.topicId))
    .innerJoin(opportunities, eq(opportunities.id, topics.opportunityId))
    .where(and(eq(articles.accountId, scope.accountId), inArray(articles.id, ids)))

  const axesByArticle = new Map<string, readonly PatternAxis[]>(
    lineage.map((row): [string, readonly PatternAxis[]] => {
      const axes: PatternAxis[] = [
        { dimension: 'intent_class', value: row.intentClass },
        // The candidate side lowercases the action the same way. The two
        // strings have to be identical or a match that should happen does not.
        { dimension: 'action_type', value: row.recommendedAction.toLowerCase() },
      ]
      for (const familyId of row.familyIds) axes.push({ dimension: 'family_id', value: familyId })
      if (row.keywordCluster) {
        axes.push({ dimension: 'keyword_cluster', value: row.keywordCluster })
      }
      return [row.articleId, axes]
    }),
  )

  return rated.map((row) => ({
    articleId: row.articleId,
    label: row.label,
    // The window the verdict is about, which is what orders one article's
    // verdicts against each other: a re-run corrects a window in place, so no
    // two live verdicts for one article share one.
    labelledAt: `${row.windowEnd}T00:00:00.000Z`,
    axes: axesByArticle.get(row.articleId) ?? [],
  }))
}

/**
 * Replaces this store's learned picture with the one just computed.
 *
 * **Replaces rather than merges, and that is what makes forgetting possible.**
 * Main §9.6.3's point about the recency window is that nothing is ever
 * permanently learned: a kind of article that stopped working loses its tilt.
 * That only happens if a group which no longer clears the bar has its row
 * *removed*. An upsert alone would leave a stale multiplier standing for ever —
 * still inside its clamp, still wrong, and invisible because the table would
 * look freshly written.
 *
 * The clear-out and the write are one transaction, so no planner ever reads a
 * store that momentarily has no patterns at all.
 *
 * Returns how many rows the store now has.
 */
export async function savePatternStats(
  db: Db,
  scope: AccountScope,
  records: readonly PatternStatRecord[],
  computedAt: Date = new Date(),
): Promise<number> {
  const values = records.map((record) => ({
    accountId: scope.accountId,
    dimension: toStored(record.dimension),
    dimensionValue: record.value,
    ratedN: record.ratedN,
    winnerN: record.winnerN,
    underperformerN: record.underperformerN,
    multiplier: record.multiplier.toFixed(4),
    computedAt,
  }))

  await db.transaction(async (tx) => {
    await tx.delete(patternStats).where(eq(patternStats.accountId, scope.accountId))
    if (values.length > 0) await tx.insert(patternStats).values(values)
  })

  return values.length
}

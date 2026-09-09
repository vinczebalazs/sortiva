import type { ArticleLabelResult } from '@sortiva/core'
import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { OPEN_OPPORTUNITY_STATUSES, articleLabels, articles, opportunities } from '../schema'
import type { AccountScope } from '../scope'
import { REPAIR_SIGNAL_TYPES } from './repair'

/**
 * The weekly verdict on each of a store's articles: the facts it is reached
 * from, where it is kept, and the one read that anything learning from it may
 * use.
 *
 * `article_labels` has no account column — it hangs off `articles`, which does
 * — so every read and write here goes through the article rather than trusting
 * an id it was handed. An article id from another store reads as "no such
 * article", not as somebody else's performance.
 */

/** The facts about one article that live in our own tables. Search Console figures come from `gscPageTotals`, keyed on the address below. */
export interface ArticleLabelInput {
  readonly articleId: string
  readonly published: boolean
  readonly publishedAt: string | null
  readonly publishedViaOverride: boolean
  readonly delivery: 'auto' | 'export'
  /** The address search performance is attributed by; null for an export article whose merchant never told us where they put it. */
  readonly publishedUrl: string | null
  readonly repairPending: boolean
}

/**
 * Every article of this store, with the facts the labelling rule gates on.
 *
 * Deliberately *not* pre-filtered to the ones that can be graded. Which
 * articles are excluded is a decision the domain rule owns and states its
 * reasons for; a repository that quietly dropped them would leave the store
 * with articles that have no row and no explanation, indistinguishable from
 * articles the recompute never reached.
 */
export async function articleLabelInputs(
  db: Db,
  scope: AccountScope,
): Promise<ArticleLabelInput[]> {
  const rows = await db
    .select({
      id: articles.id,
      state: articles.state,
      publishedAt: articles.publishedAt,
      publishedViaOverride: articles.publishedViaOverride,
      delivery: articles.delivery,
      publishedUrl: articles.publishedUrl,
    })
    .from(articles)
    .where(eq(articles.accountId, scope.accountId))
    .orderBy(articles.id)

  if (rows.length === 0) return []

  // One query for the whole store rather than one per article: a store with
  // three hundred articles would otherwise open the recompute with three
  // hundred round trips before it had looked at a single number.
  const repairs = await db
    .select({ entityRef: opportunities.entityRef })
    .from(opportunities)
    .where(
      and(
        eq(opportunities.accountId, scope.accountId),
        eq(opportunities.entityType, 'article'),
        inArray(opportunities.signalType, [...REPAIR_SIGNAL_TYPES]),
        inArray(opportunities.status, [...OPEN_OPPORTUNITY_STATUSES]),
      ),
    )
  const awaitingRepair = new Set(repairs.map((row) => row.entityRef))

  return rows.map((row) => ({
    articleId: row.id,
    published: row.state === 'published',
    publishedAt: row.publishedAt?.toISOString() ?? null,
    publishedViaOverride: row.publishedViaOverride,
    delivery: row.delivery,
    publishedUrl: row.publishedUrl,
    repairPending: awaitingRepair.has(row.id),
  }))
}

export interface LabelWindow {
  /** Inclusive `YYYY-MM-DD` bounds of the window the verdict was reached over. */
  readonly startDate: string
  readonly endDate: string
}

/**
 * Records the week's verdicts.
 *
 * It takes what the labelling rule produced and nothing else — there is no
 * shape a caller can assemble by hand that this will accept — so a label can
 * only reach this table by way of the gate that decides whether the article was
 * allowed one.
 *
 * **An unrated row is written with no figures.** The verdict is that we are not
 * judging this article, and the table has nowhere to record *why*; storing an
 * override-published article's clicks under a row that merely says `unrated`
 * would leave a real number sitting in the learning loop's own table for any
 * later query to sum. Null is the honest cell, and it makes an excluded
 * article's traffic physically absent from here rather than absent by
 * convention. The reason itself is on the returned domain record, for whoever
 * logs or reports the run.
 *
 * Rows for articles outside this account are dropped rather than written, and
 * the count returned says how many landed.
 *
 * Re-running the same week updates in place: the window is the row's identity,
 * so a second recompute corrects a verdict rather than adding a second one.
 */
export async function saveArticleLabels(
  db: Db,
  scope: AccountScope,
  window: LabelWindow,
  results: readonly ArticleLabelResult[],
  computedAt: Date = new Date(),
): Promise<number> {
  if (results.length === 0) return 0

  const owned = await db
    .select({ id: articles.id })
    .from(articles)
    .where(
      and(
        eq(articles.accountId, scope.accountId),
        inArray(
          articles.id,
          results.map((result) => result.articleId),
        ),
      ),
    )
  const ours = new Set(owned.map((row) => row.id))

  const values = results
    .filter((result) => ours.has(result.articleId))
    .map((result) => ({
      articleId: result.articleId,
      label: result.label,
      windowStart: window.startDate,
      windowEnd: window.endDate,
      clicks: result.label === 'unrated' ? null : result.current.clicks,
      impressions: result.label === 'unrated' ? null : result.current.impressions,
      meanPosition:
        result.label === 'unrated' || result.current.position === null
          ? null
          : result.current.position.toFixed(2),
      computedAt,
    }))
  if (values.length === 0) return 0

  await db
    .insert(articleLabels)
    .values(values)
    .onConflictDoUpdate({
      target: [articleLabels.articleId, articleLabels.windowStart, articleLabels.windowEnd],
      set: {
        label: sql`excluded.label`,
        clicks: sql`excluded.clicks`,
        impressions: sql`excluded.impressions`,
        meanPosition: sql`excluded.mean_position`,
        computedAt: sql`excluded.computed_at`,
      },
    })

  return values.length
}

export interface RatedArticleLabelRow {
  readonly articleId: string
  readonly label: 'winner' | 'neutral' | 'underperformer'
  readonly windowStart: string
  readonly windowEnd: string
  readonly clicks: number | null
  readonly impressions: number | null
  readonly meanPosition: number | null
}

/**
 * The verdicts anything downstream may learn from.
 *
 * There is no companion read that returns every row, because there is no
 * caller that should have one. Pattern learning, the store's headline
 * performance numbers and the calibration set all want the same thing — the
 * articles this store was actually willing to judge — and an article the
 * merchant published over our objection is not one of them. That exclusion is
 * not re-checked here: it was settled when the label was written, which is why
 * such an article is `unrated` and why `unrated` is the only thing this read
 * has to exclude.
 *
 * `since` bounds it to recently computed verdicts, so a store that has changed
 * keeps learning from what it is now.
 */
export async function ratedArticleLabels(
  db: Db,
  scope: AccountScope,
  since: Date,
): Promise<RatedArticleLabelRow[]> {
  const rows = await db
    .select({
      articleId: articleLabels.articleId,
      label: articleLabels.label,
      windowStart: articleLabels.windowStart,
      windowEnd: articleLabels.windowEnd,
      clicks: articleLabels.clicks,
      impressions: articleLabels.impressions,
      meanPosition: articleLabels.meanPosition,
    })
    .from(articleLabels)
    .innerJoin(articles, eq(articles.id, articleLabels.articleId))
    .where(
      and(
        eq(articles.accountId, scope.accountId),
        ne(articleLabels.label, 'unrated'),
        gte(articleLabels.computedAt, since),
      ),
    )
    .orderBy(articleLabels.articleId)

  return rows.map((row) => ({
    articleId: row.articleId,
    // The `unrated` member is excluded by the query above; the enum type cannot
    // know that, and widening the return type instead would push the same cast
    // onto every caller.
    label: row.label as 'winner' | 'neutral' | 'underperformer',
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    clicks: row.clicks,
    impressions: row.impressions,
    meanPosition: row.meanPosition === null ? null : Number(row.meanPosition),
  }))
}

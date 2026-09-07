import { and, desc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../client'
import { OPEN_OPPORTUNITY_STATUSES, articles, opportunities, refreshLog, topics } from '../schema'
import type { AccountScope } from '../scope'
import { REPAIR_SIGNAL_TYPES } from './repair'

/**
 * The record of every rewrite of one of our own published articles, and the
 * few facts about an article that decide whether it may be rewritten again.
 *
 * `refresh_log` has no account column — it hangs off `articles`, which does —
 * so every read here joins through the article rather than trusting an id it
 * was handed. An article id from another store therefore reads as "no such
 * article", not as somebody else's history.
 */

export interface ArticleRefreshFacts {
  readonly articleId: string
  readonly published: boolean
  readonly publishedViaOverride: boolean
  /** How this article reaches the merchant: posted by us, or downloaded by them. */
  readonly delivery: 'auto' | 'export'
  readonly lastRefreshedAt: string | null
  /** An open repair opportunity stands against this article, so a rewrite would waste the slot. */
  readonly repairPending: boolean
}

/** When this article was last rewritten, or null if it never has been. */
export async function lastArticleRefreshAt(
  db: Db,
  scope: AccountScope,
  articleId: string,
): Promise<Date | null> {
  const [row] = await db
    .select({ refreshedAt: refreshLog.refreshedAt })
    .from(refreshLog)
    .innerJoin(articles, eq(articles.id, refreshLog.articleId))
    .where(and(eq(refreshLog.articleId, articleId), eq(articles.accountId, scope.accountId)))
    .orderBy(desc(refreshLog.refreshedAt))
    .limit(1)
  return row?.refreshedAt ?? null
}

/**
 * Everything the eligibility rule needs that lives in our own tables. Where
 * the article ranks and how often it is shown come from Search Console and are
 * supplied by the caller, because a store with no Search Console connection
 * has neither and this read must still answer.
 *
 * Null means no such article in this account.
 */
export async function articleRefreshFacts(
  db: Db,
  scope: AccountScope,
  articleId: string,
): Promise<ArticleRefreshFacts | null> {
  const [article] = await db
    .select({
      id: articles.id,
      state: articles.state,
      publishedViaOverride: articles.publishedViaOverride,
      delivery: articles.delivery,
    })
    .from(articles)
    .where(and(eq(articles.id, articleId), eq(articles.accountId, scope.accountId)))
    .limit(1)
  if (!article) return null

  const [pendingRepair] = await db
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(
      and(
        eq(opportunities.accountId, scope.accountId),
        eq(opportunities.entityType, 'article'),
        eq(opportunities.entityRef, articleId),
        inArray(opportunities.signalType, [...REPAIR_SIGNAL_TYPES]),
        inArray(opportunities.status, [...OPEN_OPPORTUNITY_STATUSES]),
      ),
    )
    .limit(1)

  const lastRefreshedAt = await lastArticleRefreshAt(db, scope, articleId)

  return {
    articleId: article.id,
    published: article.state === 'published',
    publishedViaOverride: article.publishedViaOverride,
    delivery: article.delivery,
    lastRefreshedAt: lastRefreshedAt?.toISOString() ?? null,
    repairPending: pendingRepair !== undefined,
  }
}

/**
 * Records that this article has been rewritten, which is what starts its
 * cooldown.
 *
 * Append-only: the log is the history the cooldown is read from and the
 * "refreshed ×n" badge is counted from, so a second rewrite adds a row rather
 * than moving the last one. Writing for an article that is not this account's
 * inserts nothing and reports so, rather than writing a row whose article
 * belongs to somebody else.
 */
export async function recordArticleRefresh(
  db: Db,
  scope: AccountScope,
  articleId: string,
  at: Date = new Date(),
): Promise<boolean> {
  const [article] = await db
    .select({ id: articles.id })
    .from(articles)
    .where(and(eq(articles.id, articleId), eq(articles.accountId, scope.accountId)))
    .limit(1)
  if (!article) return false

  await db.insert(refreshLog).values({ articleId, refreshedAt: at })
  return true
}

/** How many times this article has been rewritten. */
export async function articleRefreshCount(
  db: Db,
  scope: AccountScope,
  articleId: string,
): Promise<number> {
  const rows = await db
    .select({ id: refreshLog.id })
    .from(refreshLog)
    .innerJoin(articles, eq(articles.id, refreshLog.articleId))
    .where(and(eq(refreshLog.articleId, articleId), eq(articles.accountId, scope.accountId)))
  return rows.length
}

/**
 * What the article was written about, read off the calendar topic it came
 * from.
 *
 * A rewrite is about the same subject as the article it replaces, so the
 * intent class and the product families are not re-derived — re-deriving them
 * would let a rewrite drift onto a different subject from the piece it is
 * meant to be a second attempt at.
 */
export interface ArticleSubject {
  readonly title: string
  readonly targetKeyword: string | null
  readonly intentClass: string
  readonly familyIds: readonly string[]
}

export async function articleSubject(
  db: Db,
  scope: AccountScope,
  articleId: string,
): Promise<ArticleSubject | null> {
  const [row] = await db
    .select({
      title: articles.title,
      targetKeyword: articles.targetKeyword,
      intentClass: topics.intentClass,
      familyIds: topics.familyIds,
    })
    .from(articles)
    .innerJoin(topics, eq(topics.id, articles.topicId))
    .where(and(eq(articles.id, articleId), eq(articles.accountId, scope.accountId)))
    .limit(1)
  if (!row) return null
  return {
    title: row.title,
    targetKeyword: row.targetKeyword,
    intentClass: row.intentClass,
    familyIds: row.familyIds ?? [],
  }
}

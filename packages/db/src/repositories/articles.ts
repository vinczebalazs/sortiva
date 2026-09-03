import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Db } from '../client'
import { articles } from '../schema'
import type { AccountScope } from '../scope'

export type ArticleRow = typeof articles.$inferSelect

/**
 * Article rows. `T4.2` wrote this shape ahead of the generation pipeline that
 * actually produces one, for `discardDraftForTopic`'s own sake (a
 * `generating`/`in_review` topic can already have a draft article row
 * pointing at it by the time it is vetoed — main §8.7's lock semantics). Its
 * own comment said production code would not call `insertArticleStub` until
 * something generated a real draft; `T4.3`'s pipeline
 * (`packages/jobs/src/generation`) is that caller now — the shape needed no
 * change, only a real title/slug/target keyword instead of placeholder ones.
 * `articles` still has no column to hold a draft's body or metadata
 * description; see this card's session report.
 */
export interface ArticleStubInput {
  readonly topicId: string
  readonly title: string
  readonly slug: string
  readonly targetKeyword: string | null
  readonly state: ArticleRow['state']
}

export async function insertArticleStub(
  db: Db,
  scope: AccountScope,
  input: ArticleStubInput,
  now: Date = new Date(),
): Promise<ArticleRow> {
  const [row] = await db
    .insert(articles)
    .values({
      accountId: scope.accountId,
      topicId: input.topicId,
      title: input.title,
      slug: input.slug,
      targetKeyword: input.targetKeyword,
      state: input.state,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  if (!row) throw new Error('failed to insert the article')
  return row
}

export async function findArticleByTopic(
  db: Db,
  scope: AccountScope,
  topicId: string,
): Promise<ArticleRow | undefined> {
  const [row] = await db
    .select()
    .from(articles)
    .where(and(eq(articles.accountId, scope.accountId), eq(articles.topicId, topicId)))
    .limit(1)
  return row
}

/** Every slug this account already has, for `stableSlug` (`packages/core/src/generation/metadata.ts`) to avoid colliding with. */
export async function slugsForAccount(db: Db, scope: AccountScope): Promise<ReadonlySet<string>> {
  const rows = await db.select({ slug: articles.slug }).from(articles).where(eq(articles.accountId, scope.accountId))
  return new Set(rows.map((r) => r.slug))
}

export interface RelatedArticleRow {
  readonly url: string
  readonly title: string
}

/**
 * The account's most recently published articles, for the internal-link
 * requirement (main §9.2: "at least one related earlier article once any
 * exist"). Only rows with a real `published_url` qualify — an article that
 * has not published yet is nothing to link to.
 */
export async function publishedArticlesForAccount(
  db: Db,
  scope: AccountScope,
  limit = 5,
): Promise<readonly RelatedArticleRow[]> {
  const rows = await db
    .select({ url: articles.publishedUrl, title: articles.title })
    .from(articles)
    .where(and(eq(articles.accountId, scope.accountId), eq(articles.state, 'published'), isNotNull(articles.publishedUrl)))
    .orderBy(desc(articles.publishedAt))
    .limit(limit)
  return rows.filter((r): r is RelatedArticleRow => r.url !== null)
}

/** Bulk lookup for the calendar list, one round trip for every topic on the visible range rather than one per topic. */
export async function findArticlesByTopics(
  db: Db,
  scope: AccountScope,
  topicIds: readonly string[],
): Promise<ArticleRow[]> {
  if (topicIds.length === 0) return []
  return db
    .select()
    .from(articles)
    .where(and(eq(articles.accountId, scope.accountId), inArray(articles.topicId, [...topicIds])))
}

/**
 * Main §8.7's "the draft is discarded (or parked as viewable-but-unpublished)"
 * - discarded, on the same reasoning `T4.0`'s `article_state` enum already
 * gives a `discarded` value distinct from `rejected` (a quality-gate failure)
 * for. Guarded to `draft`/`in_review`: an already-`published` article is a
 * publication that already happened, and main §8.7 is explicit that a veto at
 * that point is too late to mean anything (`topic_already_published` is the
 * veto route's own guard for exactly this).
 */
export async function discardDraftForTopic(
  db: Db,
  scope: AccountScope,
  topicId: string,
  now: Date = new Date(),
): Promise<ArticleRow | undefined> {
  const [row] = await db
    .update(articles)
    .set({ state: 'discarded', updatedAt: now })
    .where(
      and(
        eq(articles.accountId, scope.accountId),
        eq(articles.topicId, topicId),
        inArray(articles.state, ['draft', 'in_review']),
      ),
    )
    .returning()
  return row
}

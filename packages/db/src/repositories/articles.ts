import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../client'
import { articles } from '../schema'
import type { AccountScope } from '../scope'

export type ArticleRow = typeof articles.$inferSelect

/**
 * The minimal article-writing this card needs, ahead of the generation
 * pipeline that actually produces one (T4.3-T4.5, not yet built). A
 * `generating`/`in_review` topic can already have a draft article row
 * pointing at it by the time it is vetoed, and main §8.7's lock semantics
 * ("a veto arriving after that flip cancels *publication* - the draft is
 * discarded ... but the generation cost is already spent; we absorb it")
 * needs somewhere real to write that cancellation to. Full article
 * construction (metadata, slug rules, delivery) is T4.3's; this is only what
 * `discardDraftForTopic` needs to exist.
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

import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../client'
import { articles, topics } from '../schema'
import type { AccountScope } from '../scope'
import type { TopicRow } from './topics'

/**
 * The calendar day catches up with the article that went out on it.
 *
 * `published` is in the topic's state list and in the spec's own chain —
 * `planned → generating → in_review → published | rejected_by_gate | vetoed` —
 * and until now nothing wrote it. Two consequences, and the second is what a
 * merchant actually saw.
 *
 * A topic whose article published stayed at `in_review`, so it could still be
 * vetoed after it was live on the store. And a topic whose refusal the merchant
 * overruled stayed at `rejected_by_gate` for ever, so the monthly summary
 * counted it under "held back by our quality bar" — telling a merchant weeks
 * later that we stopped something they had decided to publish, and had.
 *
 * Called from the two places an article becomes published and inside their own
 * transactions, on the reasoning already written over `markArticleDelivered`:
 * those two cover every path, so a rule put in both cannot be reached around.
 */

/** The states an article can publish out of. `vetoed` is not one of them — see below. */
const PUBLISHABLE_FROM = ['generating', 'in_review', 'rejected_by_gate'] as const

export async function markTopicPublishedForArticle(
  db: Db,
  scope: AccountScope,
  articleId: string,
  now: Date = new Date(),
): Promise<TopicRow | undefined> {
  const behindThisArticle = db
    .select({ id: articles.topicId })
    .from(articles)
    .where(and(eq(articles.id, articleId), eq(articles.accountId, scope.accountId)))

  const [row] = await db
    .update(topics)
    .set({ state: 'published', updatedAt: now })
    .where(
      and(
        eq(topics.accountId, scope.accountId),
        inArray(topics.id, behindThisArticle),
        // Guarded rather than unconditional, so an override racing a veto loses
        // cleanly. A `vetoed` topic is deliberately absent: if an article for a
        // vetoed topic reaches publication, the veto failed to stop it, and
        // quietly relabelling the day as published would hide that rather than
        // surface it. The caller reports the miss instead.
        inArray(topics.state, [...PUBLISHABLE_FROM]),
      ),
    )
    .returning()
  return row
}

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { OPEN_OPPORTUNITY_STATUSES, articles, opportunities, refreshLog, topics } from '../schema'
import type { AccountScope } from '../scope'
import type { TopicRow } from './topics'
import type { ArticleRow } from './articles'
import type { OpportunityRow } from './opportunities'
import { assertMoveIsDrawn } from './opportunity-moves'

/**
 * The suggestion behind a published article is finished.
 *
 * Every article on a merchant's site began as a suggestion on their
 * Opportunities screen — "write something about X" — which booked a calendar
 * day, which produced the article. Until this existed nothing ever closed that
 * suggestion, so a piece of work that finished a fortnight ago sat among the
 * things still to do for ever, and the only way to tell it apart from work
 * genuinely in flight was to go and look at the article's own row.
 *
 * The trail is `article → topic → opportunity` and it is walked inside the
 * update rather than in a read beforehand, so there is no window between
 * deciding which suggestion to close and closing it.
 *
 * Guarded on the suggestion still being open. A zero-row answer means it had
 * already moved on — the merchant dismissed it, or a scan expired it, between
 * the article being written and it going out — and the caller stops rather
 * than overwriting an answer it did not give. It is never a reason to undo the
 * publication: the article is on the merchant's site either way.
 */
export async function completeOpportunityForPublishedArticle(
  db: Db,
  scope: AccountScope,
  articleId: string,
  now: Date = new Date(),
): Promise<OpportunityRow | undefined> {
  assertMoveIsDrawn(OPEN_OPPORTUNITY_STATUSES, 'completed')

  const behindThisArticle = db
    .select({ id: topics.opportunityId })
    .from(articles)
    .innerJoin(topics, eq(articles.topicId, topics.id))
    .where(and(eq(articles.id, articleId), eq(articles.accountId, scope.accountId)))

  const [row] = await db
    .update(opportunities)
    .set({ status: 'completed', appliedAt: now, updatedAt: now })
    .where(
      and(
        eq(opportunities.accountId, scope.accountId),
        inArray(opportunities.id, behindThisArticle),
        inArray(opportunities.status, [...OPEN_OPPORTUNITY_STATUSES]),
      ),
    )
    .returning()
  if (!row) return undefined

  await startRefreshCooldownIfRewrite(db, row, now)
  return row
}

/**
 * A rewrite that has gone live starts the article's cooldown.
 *
 * The cooldown exists because Google takes weeks to re-read a page and form a
 * new opinion of it; rewriting again before then is churn we pay for and the
 * merchant sees nothing from. It is measured from the moment the rewrite is
 * actually on their site, not from when it was asked for or scheduled — a
 * request that is vetoed, or a draft held back for quality, must not lock the
 * article out of being rewritten for two months.
 *
 * The row recorded is the article that was *rewritten*, which is the one the
 * piece of work named when it entered the pool — not whichever article row the
 * pipeline produced. Those are the same thing today only by accident of how a
 * rewrite is produced, and the cooldown is about the published page.
 */
async function startRefreshCooldownIfRewrite(
  db: Db,
  completed: OpportunityRow,
  now: Date,
): Promise<void> {
  if (completed.recommendedAction !== 'refresh') return
  if (completed.entityType !== 'article') return
  // Written from the articles table rather than from the reference directly:
  // a piece of work naming an article that no longer exists records nothing,
  // instead of failing a key check and rolling back a publication that has
  // already happened on the merchant's shop.
  await db.execute(sql`
    INSERT INTO ${refreshLog} (article_id, refreshed_at)
    SELECT ${articles.id}, ${now}
    FROM ${articles}
    WHERE ${articles.id} = ${completed.entityRef}::uuid
      AND ${articles.accountId} = ${completed.accountId}
  `)
}

/**
 * What a publication leaves behind: the article, and the suggestion it closed.
 *
 * `completedOpportunity` is `undefined` when the suggestion had already moved
 * on, which is worth a log line and nothing more.
 *
 * `publishedTopic` is `undefined` when the calendar day was not in a state an
 * article can publish out of — which today means it was vetoed. That is worth
 * more than a log line: the veto was supposed to stop this. It is reported
 * rather than raised, because by the time either of these runs the article may
 * already be on the merchant's shop, and rolling the record back would leave us
 * disagreeing with their store rather than with ourselves.
 */
export interface ArticlePublication {
  readonly article: ArticleRow
  readonly completedOpportunity: OpportunityRow | undefined
  readonly publishedTopic: TopicRow | undefined
}

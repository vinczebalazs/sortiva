import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../client'
import { articles, opportunities, topics } from '../schema'
import type { AccountScope } from '../scope'

/**
 * One calendar day is three rows — the article, the day itself, and the
 * suggestion the day came from — and two things race for all three of them: the
 * publish hour handing the article over, and the merchant saying "not
 * interested" to it. Postgres locks a row for whoever writes it first and makes
 * the other one wait, so if those two reach the three rows in different orders,
 * each ends up holding something the other is waiting for and Postgres kills
 * one of them outright with "deadlock detected". The merchant sees a server
 * error on a button whose whole job is to tell them, cleanly, that this has
 * already moved on.
 *
 * **The rule: any transaction that writes more than one of those three rows
 * takes them all here first, before it writes anything.** Article, then day,
 * then suggestion — and the particular order matters far less than every such
 * transaction using the same one.
 *
 * Doing it in one place is the point. This has now been got wrong twice by
 * careful people, both times the same way: someone adds a write to an existing
 * transaction, reasons correctly about the two rows they are looking at, and
 * does not notice which row that transaction is already holding from further
 * up. Once all three are taken here at the top, the order of the writes below
 * cannot reintroduce it — there is nothing left to acquire.
 *
 * It costs three cheap `SELECT ... FOR UPDATE` statements on a path that runs
 * once a day per store, or once per merchant click. Rows that do not exist —
 * a day with nothing written for it yet — simply lock nothing.
 */

/** Which day to lock, named by whichever end of it the caller is holding. */
export type DayRef = { readonly articleId: string } | { readonly topicId: string }

export async function lockDayForWrite(
  db: Db,
  scope: AccountScope,
  ref: DayRef,
): Promise<void> {
  const article = 'articleId' in ref ? eq(articles.id, ref.articleId) : eq(articles.topicId, ref.topicId)

  // Ordered so that two transactions locking several articles for one day take
  // them in the same sequence as each other, not just the same sequence of
  // tables.
  await db
    .select({ id: articles.id })
    .from(articles)
    .where(and(eq(articles.accountId, scope.accountId), article))
    .orderBy(asc(articles.id))
    .for('update')

  const day =
    'topicId' in ref
      ? eq(topics.id, ref.topicId)
      : inArray(
          topics.id,
          db
            .select({ id: articles.topicId })
            .from(articles)
            .where(and(eq(articles.accountId, scope.accountId), article)),
        )

  await db
    .select({ id: topics.id })
    .from(topics)
    .where(and(eq(topics.accountId, scope.accountId), day))
    .orderBy(asc(topics.id))
    .for('update')

  await db
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(
      and(
        eq(opportunities.accountId, scope.accountId),
        inArray(
          opportunities.id,
          db
            .select({ id: topics.opportunityId })
            .from(topics)
            .where(and(eq(topics.accountId, scope.accountId), day)),
        ),
      ),
    )
    .orderBy(asc(opportunities.id))
    .for('update')
}

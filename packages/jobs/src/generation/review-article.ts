import {
  reviewConflictFor,
  type ConflictCode,
  type Logger,
} from '@sortiva/core'
import {
  accountScope,
  approveArticleGuarded,
  discardArticleGuarded,
  findArticleById,
  vetoTopicGuarded,
  type ArticleRow,
  type Db,
} from '@sortiva/db'
import { runtimeLogger } from '../runtime/logging'

/**
 * The merchant's answer to a draft that is waiting for them — main §9.3.
 *
 * Two answers exist and no third one does. **Keeping it** returns the article
 * to the ordinary delivery path, exactly as if draft review had been off; they
 * have already given their answer, and asking again at the publish hour would
 * be asking twice. **Throwing it away** discards the article and closes the
 * calendar day it came from, because a discarded draft is a day that produced
 * nothing and the calendar has to say so rather than showing a slot that will
 * never fill.
 *
 * There is deliberately no third operation here. Editing the words is done in
 * the merchant's own store after publishing; building an editor would turn a
 * one-decision surface into a text-editing product.
 */

export interface ReviewArticleDeps {
  readonly db: Db
  readonly now?: () => Date
  readonly logger?: Logger
}

export interface ReviewArticleInput {
  readonly accountId: string
  readonly articleId: string
}

export type ReviewArticleResult =
  | { readonly ok: true; readonly article: ArticleRow }
  | { readonly ok: false; readonly code: ConflictCode }
  | { readonly ok: false; readonly code: 'not_found' }

export async function approveArticle(
  deps: ReviewArticleDeps,
  input: ReviewArticleInput,
): Promise<ReviewArticleResult> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(input.accountId)

  const existing = await findArticleById(deps.db, scope, input.articleId)
  if (!existing) return { ok: false, code: 'not_found' }

  const approved = await approveArticleGuarded(deps.db, scope, input.articleId, now)
  // Zero rows means the article moved while the merchant was looking at it —
  // a veto, a second tab, or a publish. Refuse rather than force the state.
  if (!approved) return { ok: false, code: reviewConflictFor(existing.state) }

  // The calendar entry stays `in_review` until the article actually goes out.
  // It is the publish step's to move, not this one's: approval is permission,
  // not publication.
  log.info('article_approved', { account_id: input.accountId, article_id: approved.id })
  return { ok: true, article: approved }
}

export async function discardArticle(
  deps: ReviewArticleDeps,
  input: ReviewArticleInput,
): Promise<ReviewArticleResult> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(input.accountId)

  const existing = await findArticleById(deps.db, scope, input.articleId)
  if (!existing) return { ok: false, code: 'not_found' }

  const discarded = await discardArticleGuarded(deps.db, scope, input.articleId, now)
  if (!discarded) return { ok: false, code: reviewConflictFor(existing.state) }

  // The calendar day is closed too, or the slot would sit in `in_review`
  // forever describing a decision that has been made. It closes as `vetoed`,
  // which is what happened: the merchant read what we wrote and said no.
  //
  // Deliberately the bare state change and not the full veto operation — a
  // discarded draft is a judgement on this article, not on the subject, so the
  // search term does not go on the not-interested list and the opportunity
  // behind it is not dismissed. Someone who wants the subject dropped vetoes
  // the topic, which is a different action with different consequences. See
  // DECISIONS 2026-09-03 T4.5.
  const closed = await vetoTopicGuarded(deps.db, scope, discarded.topicId, null, now)

  log.info('article_discarded', {
    account_id: input.accountId,
    article_id: discarded.id,
    topic_closed: closed !== undefined,
  })
  return { ok: true, article: discarded }
}

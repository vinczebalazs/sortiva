import type { ConflictCode } from '@sortiva/core'
import type { Db } from '@sortiva/db'
// Deep imports, not the `@sortiva/jobs` barrel — see the identical note in
// `apps/web/app/api/calendar/_lib/handlers.ts`, which hit the build failure
// this avoids.
import { approveArticle, discardArticle } from '@sortiva/jobs/generation/review-article'
import type { AccountHandler } from '../../auth/_lib/session'

/**
 * The two things a merchant may do with a draft that is waiting for them, and
 * the two things only — main §9.3: "the user reads the rendered draft and
 * **approves or discards** — there is deliberately **no in-app editor**."
 *
 * There is no route here that changes an article's words, and there is not
 * meant to be: someone who wants different wording changes it in their own
 * store after publishing.
 *
 * Both handlers are parse → call `packages/jobs/src/generation` → serialise.
 * The state machine and its guards live there.
 */

export interface ReviewDeps {
  readonly db: Db
  readonly now?: () => Date
}

export type RouteCtx = { readonly params: Promise<{ articleId: string }> }

const CONFLICT_MESSAGES: Partial<Record<ConflictCode, string>> = {
  article_not_in_review: 'This draft is no longer waiting for a decision.',
  article_already_published: 'This article has already been published.',
}

function conflict(code: ConflictCode): Response {
  return Response.json(
    { error: { code, message: CONFLICT_MESSAGES[code] ?? 'That change could not be made.' } },
    { status: 409 },
  )
}

function notFound(): Response {
  return Response.json(
    { error: { code: 'article_not_found', message: 'That article is gone.' } },
    { status: 404 },
  )
}

export function makeApproveArticleHandler(deps: ReviewDeps): AccountHandler<RouteCtx> {
  return async (_request, { scope, route }) => {
    const { articleId } = await route.params
    const result = await approveArticle(
      { db: deps.db, ...(deps.now ? { now: deps.now } : {}) },
      { accountId: scope.accountId, articleId },
    )
    if (!result.ok) return result.code === 'not_found' ? notFound() : conflict(result.code)
    return Response.json({ ok: true })
  }
}

export function makeDiscardArticleHandler(deps: ReviewDeps): AccountHandler<RouteCtx> {
  return async (_request, { scope, route }) => {
    const { articleId } = await route.params
    const result = await discardArticle(
      { db: deps.db, ...(deps.now ? { now: deps.now } : {}) },
      { accountId: scope.accountId, articleId },
    )
    if (!result.ok) return result.code === 'not_found' ? notFound() : conflict(result.code)
    return Response.json({ ok: true })
  }
}

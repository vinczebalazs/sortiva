import { withAccount, type AccountContext } from '../../../auth/_lib/session'
import { reviewDeps } from '../../_lib/config'
import { makeDiscardArticleHandler, type RouteCtx } from '../../_lib/review'

/**
 * `POST /api/articles/{articleId}/discard` — the merchant throws away a draft
 * that was waiting for them, and the calendar day closes with it. Main §9.3.
 */
export const dynamic = 'force-dynamic'

// `reviewDeps()` deferred to request time — see the note in `_lib/config.ts`.
export const POST = withAccount((request, context: AccountContext<RouteCtx>) =>
  makeDiscardArticleHandler(reviewDeps())(request, context),
)

import { withAccount, type AccountContext } from '../../../auth/_lib/session'
import { reviewDeps } from '../../_lib/config'
import { makeApproveArticleHandler, type RouteCtx } from '../../_lib/review'

/**
 * `POST /api/articles/{articleId}/approve` — the merchant keeps a draft that
 * was waiting for them. Main §9.3.
 */
export const dynamic = 'force-dynamic'

// `reviewDeps()` deferred to request time — see the note in `_lib/config.ts`.
export const POST = withAccount((request, context: AccountContext<RouteCtx>) =>
  makeApproveArticleHandler(reviewDeps())(request, context),
)

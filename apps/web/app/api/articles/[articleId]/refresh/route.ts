import { withAccount, type AccountContext } from '../../../auth/_lib/session'
import { refreshRouteDeps } from '../../_lib/config'
import { makeRequestRefreshHandler, type RefreshRouteCtx } from '../../_lib/refresh'

/**
 * `POST /api/articles/{articleId}/refresh` — the merchant asks for one of our
 * own published articles to be rewritten.
 */
export const dynamic = 'force-dynamic'

// `refreshRouteDeps()` deferred to request time — see the note in `_lib/config.ts`.
export const POST = withAccount((request, context: AccountContext<RefreshRouteCtx>) =>
  makeRequestRefreshHandler(refreshRouteDeps())(request, context),
)

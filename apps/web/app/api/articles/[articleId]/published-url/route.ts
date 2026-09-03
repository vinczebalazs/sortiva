import { withAccount, type AccountContext } from '../../../auth/_lib/session'
import { deliveryDeps } from '../../_lib/config'
import { makeConfirmPublishedUrlHandler, type RouteCtx } from '../../_lib/delivery'

/**
 * `POST /api/articles/{articleId}/published-url` — where the merchant put a
 * downloaded article.
 *
 * Checked against the domain this account claimed before it is stored: search
 * performance is attributed by address, and an address on somebody else's site
 * would credit this store with another store's traffic. Main §9.4, §12.2.
 */
export const dynamic = 'force-dynamic'

// `deliveryDeps()` deferred to request time — see the note in `_lib/config.ts`.
export const POST = withAccount((request, context: AccountContext<RouteCtx>) =>
  makeConfirmPublishedUrlHandler(deliveryDeps())(request, context),
)

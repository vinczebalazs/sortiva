import { withAccount, type AccountContext } from '../../../auth/_lib/session'
import { deliveryDeps } from '../../_lib/config'
import { makeExportArticleHandler, type RouteCtx } from '../../_lib/delivery'

/**
 * `GET /api/articles/{articleId}/export` — the download an export-mode merchant
 * came for: the article as Markdown, as HTML, and its metadata block.
 *
 * Every price and product address in it is read from the store as it is right
 * now, so a merchant who changed a price this morning downloads this morning's
 * price. Main §9.4, §9.5.
 */
export const dynamic = 'force-dynamic'

// `deliveryDeps()` deferred to request time — see the note in `_lib/config.ts`.
export const GET = withAccount((request, context: AccountContext<RouteCtx>) =>
  makeExportArticleHandler(deliveryDeps())(request, context),
)

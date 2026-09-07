import { withAccount, type AccountContext } from '../../auth/_lib/session'
import { libraryDeps } from '../_lib/config'
import { makeGetArticleHandler, type ArticleRouteCtx } from '../_lib/library'

/**
 * `GET /api/articles/{articleId}` — one article, exactly as it would publish,
 * and the decisions left to make about it. Read-only: there is no editor
 * anywhere in the product and no route to one.
 */
export const dynamic = 'force-dynamic'

// `libraryDeps()` deferred to request time — see the note in `_lib/config.ts`.
export const GET = withAccount((request, context: AccountContext<ArticleRouteCtx>) =>
  makeGetArticleHandler(libraryDeps())(request, context),
)

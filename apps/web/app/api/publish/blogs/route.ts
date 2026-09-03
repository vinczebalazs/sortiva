import { withAccount, type AccountContext } from '../../auth/_lib/session'
import { publishGrantDeps } from '../_lib/config'
import { makeListBlogsHandler } from '../_lib/handlers'

/**
 * `GET /api/publish/blogs` — the blogs on the merchant's store, to choose a posting target from. Main §9.5.
 */
export const dynamic = 'force-dynamic'

// `publishGrantDeps()` deferred to request time — see the note in `_lib/config.ts`.
export const GET = withAccount((request: Request, context: AccountContext) =>
  makeListBlogsHandler(publishGrantDeps())(request, context),
)

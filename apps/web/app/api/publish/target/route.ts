import { withAccount, type AccountContext } from '../../auth/_lib/session'
import { publishGrantDeps } from '../_lib/config'
import { makeSetTargetBlogHandler } from '../_lib/handlers'

/**
 * `POST /api/publish/target` — choose the blog auto-publish posts to, or create one. Main §9.5.
 */
export const dynamic = 'force-dynamic'

// `publishGrantDeps()` deferred to request time — see the note in `_lib/config.ts`.
export const POST = withAccount((request: Request, context: AccountContext) =>
  makeSetTargetBlogHandler(publishGrantDeps())(request, context),
)

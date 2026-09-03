import { withAccount, type AccountContext } from '../../../auth/_lib/session'
import { publishGrantDeps } from '../../_lib/config'
import { makeStartPublishGrantHandler } from '../../_lib/handlers'

/**
 * `POST /api/publish/grant/start` — the address of Shopify's second consent screen, the one that adds permission to post. Main §9.5.
 */
export const dynamic = 'force-dynamic'

// `publishGrantDeps()` deferred to request time — see the note in `_lib/config.ts`.
export const POST = withAccount((request: Request, context: AccountContext) =>
  makeStartPublishGrantHandler(publishGrantDeps())(request, context),
)

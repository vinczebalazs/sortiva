import { withAccount, type AccountContext } from '../../../auth/_lib/session'
import { publishGrantDeps } from '../../_lib/config'
import { makePublishGrantCallbackHandler } from '../../_lib/handlers'

/**
 * `GET /api/publish/grant/callback` — the merchant returning from Shopify's second consent screen. Main §9.5, §14.3.7.
 */
export const dynamic = 'force-dynamic'

// `publishGrantDeps()` deferred to request time — see the note in `_lib/config.ts`.
export const GET = withAccount((request: Request, context: AccountContext) =>
  makePublishGrantCallbackHandler(publishGrantDeps())(request, context),
)

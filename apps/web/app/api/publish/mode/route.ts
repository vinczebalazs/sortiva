import { withAccount, type AccountContext } from '../../auth/_lib/session'
import { publishGrantDeps } from '../_lib/config'
import { makeSetDeliveryModeHandler } from '../_lib/handlers'

/**
 * `POST /api/publish/mode` — switch auto-publish on or off, and choose live or Shopify-draft. Main §9.4, §9.5.
 */
export const dynamic = 'force-dynamic'

// `publishGrantDeps()` deferred to request time — see the note in `_lib/config.ts`.
export const POST = withAccount((request: Request, context: AccountContext) =>
  makeSetDeliveryModeHandler(publishGrantDeps())(request, context),
)

import { withAccount, type AccountContext } from '../../../auth/_lib/session'
import { overrideDeps } from '../../_lib/config'
import { makeOverridePublishHandler, type OverrideRouteCtx } from '../../_lib/override'

/**
 * `POST /api/articles/{articleId}/publish-anyway` — the merchant publishes a
 * draft our quality bar rejected. It is their site.
 */
export const dynamic = 'force-dynamic'

// `overrideDeps()` deferred to request time — see the note in `_lib/config.ts`.
export const POST = withAccount((request, context: AccountContext<OverrideRouteCtx>) =>
  makeOverridePublishHandler(overrideDeps())(request, context),
)

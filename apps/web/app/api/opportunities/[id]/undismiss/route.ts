import { withAccount, type AccountContext } from '../../../auth/_lib/session'
import { opportunitiesDeps } from '../../_lib/config'
import { makeUndismissOpportunityHandler, type OpportunityRouteCtx } from '../../_lib/handlers'

/** `POST /api/opportunities/{id}/undismiss` — the "show dismissed, restore" control (main §7.9). */
export const dynamic = 'force-dynamic'

export const POST = withAccount((request, context: AccountContext<OpportunityRouteCtx>) =>
  makeUndismissOpportunityHandler(opportunitiesDeps())(request, context),
)

import { withAccount, type AccountContext } from '../../../auth/_lib/session'
import { opportunitiesDeps } from '../../_lib/config'
import { makeDismissOpportunityHandler, type OpportunityRouteCtx } from '../../_lib/handlers'

/** `POST /api/opportunities/{id}/dismiss` — ui §5.4: undo toast, 5s. */
export const dynamic = 'force-dynamic'

export const POST = withAccount((request, context: AccountContext<OpportunityRouteCtx>) =>
  makeDismissOpportunityHandler(opportunitiesDeps())(request, context),
)

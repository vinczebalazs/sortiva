import { withAccount, type AccountContext } from '../../../auth/_lib/session'
import { opportunitiesDeps } from '../../_lib/config'
import { makeScheduleOpportunityHandler, type OpportunityRouteCtx } from '../../_lib/handlers'

/** `POST /api/opportunities/{id}/schedule` — ui §5.4. */
export const dynamic = 'force-dynamic'

export const POST = withAccount((request, context: AccountContext<OpportunityRouteCtx>) =>
  makeScheduleOpportunityHandler(opportunitiesDeps())(request, context),
)

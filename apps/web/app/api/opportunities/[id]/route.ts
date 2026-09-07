import { withAccount, type AccountContext } from '../../auth/_lib/session'
import { opportunitiesDeps } from '../_lib/config'
import { makeOpportunityDetailHandler, type OpportunityRouteCtx } from '../_lib/handlers'

/** `GET /api/opportunities/{id}` — the detail drawer: evidence, tasks, recommendation, history, outcome. */
export const dynamic = 'force-dynamic'

export const GET = withAccount((request, context: AccountContext<OpportunityRouteCtx>) =>
  makeOpportunityDetailHandler(opportunitiesDeps())(request, context),
)

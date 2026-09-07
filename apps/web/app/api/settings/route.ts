import { withAccount, type AccountContext } from '../auth/_lib/session'
import { settingsDeps } from './_lib/config'
import { makeReadSettingsHandler, makeUpdateSettingsHandler } from './_lib/handlers'

/**
 * `GET /api/settings` — everything the two Settings screens show.
 * `PATCH /api/settings` — the ones the merchant changed, and nothing else.
 */
export const dynamic = 'force-dynamic'

export const GET = withAccount((request: Request, context: AccountContext) =>
  makeReadSettingsHandler(settingsDeps())(request, context),
)

export const PATCH = withAccount((request: Request, context: AccountContext) =>
  makeUpdateSettingsHandler(settingsDeps())(request, context),
)

import { withAccount } from '../../../auth/_lib/session'
import { gscCallbackHandler } from '../../_lib/handlers'

/**
 * Where Google sends the merchant back to. Called by the browser following
 * Google's redirect, so it answers with a redirect of its own and never with
 * JSON — which is also why it is not in the API contract the front end is built
 * against: nothing in the app ever calls it directly.
 *
 * The flow has to finish in the account that started it, which is checked
 * against the session here rather than trusted from the URL.
 */
export const dynamic = 'force-dynamic'

export const GET = withAccount(gscCallbackHandler)

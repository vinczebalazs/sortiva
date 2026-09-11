import { withAccountFromBrowser } from '../../../auth/_lib/session'
import { shopifyOauthDeps } from '../../_lib/config'
import { makeCallbackHandler } from '../../_lib/handlers'

/**
 * Where Shopify sends the merchant's browser after they decide.
 *
 * A browser arrives here, not a client, so every outcome is a redirect back to
 * the dashboard carrying what happened — and the session still decides whose
 * install this is, which is what stops a link completing an install in somebody
 * else's account.
 */
export const dynamic = 'force-dynamic'

export const GET = withAccountFromBrowser(makeCallbackHandler(shopifyOauthDeps))

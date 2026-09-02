import { withAccount } from '../../../auth/_lib/session'
import { shopifyOauthDeps } from '../../_lib/config'
import { makeStartHandler } from '../../_lib/handlers'

/**
 * Begins the Shopify install. Answers with the address to send the browser to,
 * asking for read permission only — publishing is a separate, later grant.
 *
 * Not gated on billing: reading a merchant's own store is never revoked.
 */
export const dynamic = 'force-dynamic'

export const POST = withAccount(makeStartHandler(shopifyOauthDeps))

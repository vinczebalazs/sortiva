import { withAccount } from '../../auth/_lib/session'
import { portalHandler } from '../_lib/handlers'

/**
 * Stripe's Customer Portal is where cards, invoices and cancellation live. A
 * `past_due` or `canceled` account must be able to reach it — that is how they
 * fix the problem — so this route is never gated on entitlement.
 */
export const dynamic = 'force-dynamic'

export const POST = withAccount(portalHandler)

import { withAccount } from '../../auth/_lib/session'
import { portalHandler } from '../_lib/handlers'

/**
 * main §4.2, ui §9.4 — Stripe's Customer Portal is where cards, invoices and
 * cancellation live. A `past_due` or `canceled` account must be able to reach
 * it, so this route is never gated on entitlement (invariant 16).
 */
export const dynamic = 'force-dynamic'

export const POST = withAccount(portalHandler)

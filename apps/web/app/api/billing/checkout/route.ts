import { withAccount } from '../../auth/_lib/session'
import { checkoutHandler } from '../_lib/handlers'

/**
 * main §4.2, ui §2.3 — Stripe Checkout in subscription mode. Deliberately
 * carries no entitlement check: this is the route an unentitled account uses to
 * become entitled.
 */
export const dynamic = 'force-dynamic'

export const POST = withAccount(checkoutHandler)

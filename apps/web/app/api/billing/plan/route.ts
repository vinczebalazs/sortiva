import { planHandler } from '../_lib/handlers'

/**
 * The plan card: the price, the monthly/annual toggle and the cap line, used
 * word for word. Public, because the plan screen is reachable before
 * signup; read-only, because it changes nothing and reads no account.
 *
 * Amounts live in Stripe alone, so the price is fetched from Stripe
 * and cached rather than written down here. That is what makes repricing a
 * Stripe change instead of a code change.
 */
export const dynamic = 'force-dynamic'

export const GET = planHandler

import { planHandler } from '../_lib/handlers'

/**
 * ui §2.3 — the plan card: the price, the monthly/annual toggle and the
 * verbatim cap line. Public, because the plan screen is reachable before
 * signup; read-only, because it changes nothing and reads no account.
 *
 * main §4.2 keeps amounts in Stripe alone, so the price is fetched from Stripe
 * and cached rather than written down here. That is what makes repricing a
 * Stripe change instead of a code change.
 */
export const dynamic = 'force-dynamic'

export const GET = planHandler

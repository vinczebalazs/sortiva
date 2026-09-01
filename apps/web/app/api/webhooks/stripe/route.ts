import { stripeWebhookRoute } from './_lib/route-handler'

/**
 * Stripe's receiver. Public by necessity: the
 * signature is the authentication, which is why it is verified before anything
 * touches the body.
 */
export const dynamic = 'force-dynamic'

export const POST = stripeWebhookRoute

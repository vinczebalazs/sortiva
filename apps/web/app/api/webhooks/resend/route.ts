import { resendWebhookRoute } from './_lib/route-handler'

/**
 * Resend's receiver. Public by necessity: the signature is the
 * authentication, which is why it is verified before anything touches the body.
 */
export const dynamic = 'force-dynamic'

export const POST = resendWebhookRoute

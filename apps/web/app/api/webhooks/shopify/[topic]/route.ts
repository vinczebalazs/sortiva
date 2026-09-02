import { makeShopifyWebhookRoute } from './_lib/route-handler'

/**
 * Shopify's receiver, one route per topic they deliver to. Public by necessity:
 * the signature is the authentication, which is why it is verified before
 * anything touches the body.
 */
export const dynamic = 'force-dynamic'

export const POST = makeShopifyWebhookRoute

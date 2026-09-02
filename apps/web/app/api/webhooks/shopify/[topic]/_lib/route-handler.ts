import { shopifyWebhookOptions } from '../../../../shopify/_lib/config'
import { makeShopifyWebhookRoute as build } from './receiver'

/** The production binding, kept out of `route.ts` so tests can build their own. */
export const makeShopifyWebhookRoute = build(shopifyWebhookOptions())

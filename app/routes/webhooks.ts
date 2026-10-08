import type { ActionFunctionArgs } from 'react-router'
import { CONFIG } from '../../core/config.ts'
import { verifyShopifyWebhook } from '../../connectors/shopify/webhooks.ts'
import { acceptDelivery } from '../../jobs/intake.ts'
import { db, shopifyApp } from '../server/context.server.ts'

// Shopify waits five seconds at most: verify, record, queue, answer. The work happens in the worker.
export async function action({ request }: ActionFunctionArgs) {
  const raw = await request.text()
  const headers = Object.fromEntries(request.headers.entries())
  const delivery = verifyShopifyWebhook(headers, raw, shopifyApp().clientSecret)
  if (!delivery) return new Response(null, { status: 401 })
  await acceptDelivery({ pool: db(), webhookDebounceMs: CONFIG.webhookDebounceMs }, delivery)
  return new Response(null, { status: 200 })
}

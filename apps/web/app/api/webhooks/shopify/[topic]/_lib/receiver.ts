import { isKnownTopic } from '@sortiva/core'
import { db, recordWebhookEvent, systemScope, type Database } from '@sortiva/db'
import { shopHandleFrom, verifyWebhookHmac } from '@sortiva/providers'
// A deep import, not the package barrel: the barrel re-exports the spend-cap
// sweep, which pulls the threshold config's file loader into a bundle with no
// filesystem. The domain claim and the Search Console routes take the same
// shape. See DECISIONS 2026-09-01 T1.3 and 2026-09-02 T-START.
import { enqueueShopifyWebhookDrain } from '@sortiva/jobs/ingestion/queue'

/**
 * Where Shopify tells us a merchant changed something.
 *
 * The receiver does three things and deliberately nothing else: prove the
 * message really came from Shopify, write it down, and answer. Shopify expects a
 * 200 within five seconds and retries anything slower, eventually dropping the
 * subscription altogether — so no decision, no lookup and no model call happens
 * on this path. The work is done afterwards, from the written-down copy.
 *
 * Public by necessity, like every webhook: the signature is the authentication,
 * which is why it is checked before anything touches the body.
 */

export interface ShopifyReceiverOptions {
  /** The app secret Shopify signs with. Read from the environment in production. */
  secret?: string
  database?: Database
  /** Off in tests that assert on the response alone. */
  enqueue?: boolean
}

const ACK = { received: true } as const

export async function handleShopifyWebhook(
  request: Request,
  topicFromPath: string,
  options: ShopifyReceiverOptions = {},
): Promise<Response> {
  const secret = options.secret ?? process.env.SHOPIFY_API_SECRET
  if (!secret) {
    // Refusing is the safe direction: without a secret every signature check
    // would pass and anyone could write into a merchant's catalogue record.
    return problem(500, 'webhook_not_configured', 'Shopify webhooks are not configured.')
  }

  // The raw bytes, not the parsed body. The signature covers exactly what was
  // sent, and re-serialising parsed JSON changes whitespace and key order.
  const raw = Buffer.from(await request.arrayBuffer())
  const signature = request.headers.get('x-shopify-hmac-sha256') ?? ''
  if (!verifyWebhookHmac(raw, signature, secret)) {
    return problem(401, 'invalid_signature', 'Signature verification failed.')
  }

  // Shopify's own name for this delivery. Without it we cannot tell a
  // redelivery from a new event, so there is nothing safe to do with it.
  const webhookId = request.headers.get('x-shopify-webhook-id')
  if (!webhookId) {
    return problem(400, 'missing_webhook_id', 'The delivery carried no webhook id.')
  }

  const topic = request.headers.get('x-shopify-topic') ?? topicFromPath
  const shopDomain = request.headers.get('x-shopify-shop-domain') ?? ''
  const shopHandle = shopHandleFrom(shopDomain)

  if (!isKnownTopic(topic)) {
    // Genuine, but for something we never subscribed to. Answered 200 so
    // Shopify stops retrying, and dropped.
    return Response.json(ACK)
  }

  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
  } catch {
    return problem(400, 'invalid_body', 'The delivery body was not JSON.')
  }

  const database = options.database ?? db()
  const system = systemScope('a webhook is verified and stored before it is routed to an account')

  // Insert-or-ignore on Shopify's own delivery id: a redelivery writes nothing
  // and still gets its 200, which is what makes a duplicate free rather than
  // merely harmless.
  const stored = await recordWebhookEvent(database, system, {
    webhookId,
    source: 'shopify',
    topic,
    // The store's name arrives in a header rather than in the body, and the
    // table has no column for it. Keeping it beside the body is what lets the
    // drain answer "whose store is this" without the request still being open.
    payload: { shop_handle: shopHandle, body },
  })

  if (stored && options.enqueue !== false && shopHandle) {
    // Started but not awaited past this point: the 200 has to go back now. Safe
    // to lose — the row is already written, and the nightly sweep finds anything
    // the drain missed.
    await enqueueShopifyWebhookDrain(database, { shopHandle })
  }

  return Response.json(ACK)
}

function problem(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status })
}

export function makeShopifyWebhookRoute(options: ShopifyReceiverOptions = {}) {
  return async (request: Request, context: { params: Promise<{ topic: string }> }) => {
    const { topic } = await context.params
    return handleShopifyWebhook(request, decodeURIComponent(topic), options)
  }
}

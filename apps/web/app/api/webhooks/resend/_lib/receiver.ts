import { systemScope, db as defaultDb, recordWebhookEvent, type Db } from '@sortiva/db'
import { makeEmailStore } from '@sortiva/db'
import {
  WebhookVerificationError,
  parseResendEvent,
  suppressionReasonFor,
  verifyResendWebhook,
  webhookHeadersFrom,
} from '@sortiva/providers'

/**
 * Bounces and spam complaints, arriving from Resend.
 *
 * Same shape as the Stripe and Shopify receivers: prove it came from the
 * vendor, store it, answer 200, decide afterwards. The receiver's job is
 * deliberately tiny, so a slow decision can never make the vendor time us out
 * and redeliver, and a crash mid-decision loses nothing — the stored row is
 * still there.
 *
 * What it decides is small and consequential: an address that bounced or was
 * reported as spam is added to the suppression list, and from that moment
 * nothing is mailed to it. Continuing to mail an address that bounces is how a
 * sending domain's reputation dies, and it takes every other merchant's mail
 * with it.
 */

export interface ResendReceiverOptions {
  database?: Db
  secret?: string
  now?: () => Date
}

export async function handleResendWebhook(
  request: Request,
  options: ResendReceiverOptions = {},
): Promise<Response> {
  // The raw text, not the parsed body: the signature covers the exact bytes,
  // and re-serialising JSON changes them.
  const rawBody = await request.text()
  const secret = options.secret ?? process.env.RESEND_WEBHOOK_SECRET ?? ''

  try {
    verifyResendWebhook(
      rawBody,
      webhookHeadersFrom(request.headers),
      secret,
      options.now?.() ?? new Date(),
    )
  } catch (thrown) {
    if (thrown instanceof WebhookVerificationError) {
      return Response.json(
        { error: { code: 'invalid_signature', message: 'Signature verification failed.' } },
        { status: 400 },
      )
    }
    throw thrown
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return Response.json(
      { error: { code: 'invalid_body', message: 'The body is not JSON.' } },
      { status: 400 },
    )
  }

  const database = options.database ?? defaultDb()
  const event = parseResendEvent(payload)
  const webhookId = request.headers.get('svix-id') ?? request.headers.get('webhook-id') ?? ''

  // Insert-or-ignore by the vendor's own id, then act from what we stored, so a
  // redelivery costs one refused insert rather than a second suppression.
  const stored = await recordWebhookEvent(
    database,
    systemScope('a webhook is verified and stored before we know which account it concerns'),
    {
      webhookId,
      source: 'resend',
      topic: event?.type ?? 'unknown',
      payload: (payload ?? {}) as Record<string, unknown>,
    },
  )
  if (!stored) return Response.json({ received: true, duplicate: true })

  const reason = event ? suppressionReasonFor(event.type) : undefined
  if (event && reason) {
    const store = makeEmailStore({ database })
    // Every recipient of the delivery, because the bounce is about the address
    // rather than about the message.
    for (const address of event.recipients) await store.suppress(address, reason)
  }

  return Response.json({ received: true })
}

export function makeResendWebhookRoute(options: ResendReceiverOptions = {}) {
  return (request: Request) => handleResendWebhook(request, options)
}

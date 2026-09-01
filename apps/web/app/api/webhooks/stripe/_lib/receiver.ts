import {
  drainStripeEvents,
  WebhookSignatureError,
  type BillingWorkerDeps,
  type StripeBillingProvider,
} from '@sortiva/core'
import { StubNotificationEmitter } from '@sortiva/core'
import { dbPool, type Db } from '@sortiva/db'
import { PosthogServerCapture } from '@sortiva/providers'
import {
  makeBillingStore,
  makeStripeEventStore,
  type BillingStoreOptions,
} from '../../../billing/_lib/store'
import { stripeProvider } from '../../../billing/_lib/config'

/**
 * tech §3 — "signature verification (`stripe.webhooks.constructEvent`),
 * insert-or-ignore into `stripe_events` by event ID, 200 immediately, async
 * processing — same pattern" as the Shopify receiver (main §14.3.8).
 *
 * The receiver's job is deliberately tiny: prove the payload came from Stripe,
 * store it, answer. Everything that decides anything runs against the stored
 * row, so a slow decision can never make Stripe time us out and retry, and a
 * crash mid-decision loses nothing.
 */

export interface ReceiverOptions {
  database?: Db
  pool?: BillingStoreOptions['pool']
  stripe?: StripeBillingProvider
  deps?: Partial<BillingWorkerDeps>
  /** Off in tests that assert on the response alone. */
  drain?: boolean
}

let capture: PosthogServerCapture | undefined

export function billingWorkerDeps(options: ReceiverOptions = {}): BillingWorkerDeps {
  const database = options.database
  // Invariant 18 — all work for one account serialises. The pool has to come
  // from the composition root: with none, `makeBillingStore` silently skips the
  // per-account lock, so before this card the lock engaged only in tests, which
  // are the one place it was never needed. A test handing in its own isolated
  // database supplies the matching pool; production takes the shared one, so
  // the lock and the write always meet on the same database.
  const pool = options.pool ?? (database ? undefined : dbPool())
  const storeOptions = {
    ...(database ? { database } : {}),
    ...(pool ? { pool } : {}),
  }
  capture ??= new PosthogServerCapture()
  return {
    billing: makeBillingStore(storeOptions),
    events: makeStripeEventStore(storeOptions),
    stripe: options.stripe ?? stripeProvider(),
    // main §4.2 — the payment-failed email. Until Lane G's T8.1 fills
    // `NotificationEmitter`, the registered stub records the emission and
    // reports itself through `pnpm stubs:report`, so the gap is visible rather
    // than silently absent.
    notifications: new StubNotificationEmitter(capture),
    capture,
    ...options.deps,
  }
}

export async function handleStripeWebhook(
  request: Request,
  options: ReceiverOptions = {},
): Promise<Response> {
  const stripe = options.stripe ?? stripeProvider()
  // The raw text, not the parsed body: the signature covers the exact bytes,
  // and re-serialising JSON changes them.
  const rawBody = await request.text()
  const signature = request.headers.get('stripe-signature')

  let envelope
  try {
    envelope = stripe.constructEvent(rawBody, signature)
  } catch (thrown) {
    if (thrown instanceof WebhookSignatureError) {
      return Response.json(
        { error: { code: 'invalid_signature', message: 'Signature verification failed.' } },
        { status: 400 },
      )
    }
    throw thrown
  }

  const deps = billingWorkerDeps({ ...options, stripe })
  await deps.events.record({
    eventId: envelope.id,
    type: envelope.type,
    payload: envelope.payload,
  })

  if (options.drain !== false) {
    // Started, not awaited: tech §3 requires the 200 now. The drain is safe to
    // lose — it reads the table it did not empty, the nightly reconciliation
    // repairs anything it missed, and every step is idempotent.
    void drainStripeEvents(deps).catch((error: unknown) => {
      console.error('[stripe] drain failed', error)
    })
  }

  return Response.json({ received: true })
}

export function makeStripeWebhookRoute(options: ReceiverOptions = {}) {
  return (request: Request) => handleStripeWebhook(request, options)
}

/** Exposed for the worker task and for tests that want a synchronous drain. */
export async function drainNow(options: ReceiverOptions = {}) {
  return drainStripeEvents(billingWorkerDeps(options))
}

import {
  drainStripeEvents,
  WebhookSignatureError,
  type BillingWorkerDeps,
  type StripeBillingProvider,
} from '@sortiva/core'
import { db, dbPool, type Db } from '@sortiva/db'
// Deep import, not the package barrel: `@sortiva/jobs`'s index re-exports the
// Graphile Worker runtime, which would drag the worker library into every
// request bundle that touches this file.
import { DbNotificationEmitter } from '@sortiva/jobs/notify/emitter'
import { PosthogServerCapture } from '@sortiva/providers'
import {
  makeBillingStore,
  makeStripeEventStore,
  type BillingStoreOptions,
} from '../../../billing/_lib/store'
import { stripeProvider } from '../../../billing/_lib/config'

/**
 * Verify the signature, insert-or-ignore into `stripe_events` by event id,
 * answer 200 immediately, process afterwards — the same pattern as the Shopify
 * receiver.
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
    // The payment-failed email, and the bell entry that goes with it. The
    // database factory rather than a handle where there is none: this module is
    // loaded when its route file is, and opening a connection then would open
    // one during the build. A test hands in its own handle so the notification
    // lands in the same database as the subscription row it reports.
    notifications: new DbNotificationEmitter(database ?? db),
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
    // Started, not awaited: the 200 has to go back now. The drain is safe to
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

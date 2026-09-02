import { db, type Db } from '../client'
import { recordWebhookEvent } from '../repositories/system'
import { systemScope } from '../scope'
import type { WebhookEventRow } from '../repositories/system'

/**
 * Storing a vendor's webhook before deciding anything about it.
 *
 * A receiver has no account when the request arrives — that is the point of a
 * webhook — and it must answer the vendor quickly or be timed out and
 * redelivered. So it stores first and decides afterwards, and this is the port
 * that lets it do that without holding a database handle of its own.
 *
 * It lives here, beside the query, for the same reason the bell's store does: a
 * database handle outside this package is how a query ends up running without
 * naming the account it is for.
 */
export interface WebhookEventStoreOptions {
  /** An integration test hands in its own isolated database; production uses the pool. */
  database?: Db
}

export interface WebhookEventStore {
  /**
   * Insert-or-ignore on the vendor's own delivery id. `undefined` means we have
   * already seen this delivery, which is how a redelivery costs one refused
   * insert rather than a second decision.
   */
  record(input: {
    webhookId: string
    source: WebhookEventRow['source']
    topic: string
    payload: Record<string, unknown>
  }): Promise<WebhookEventRow | undefined>
}

export function makeWebhookEventStore(options: WebhookEventStoreOptions = {}): WebhookEventStore {
  const database = (): Db => options.database ?? db()

  return {
    record(input) {
      return recordWebhookEvent(
        database(),
        systemScope('a webhook is verified and stored before we know which account it concerns'),
        input,
      )
    },
  }
}

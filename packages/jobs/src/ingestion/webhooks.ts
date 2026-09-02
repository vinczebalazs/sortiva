import {
  NO_CUSTOMER_DATA_HELD,
  accountAttribution,
  classifyProductChange,
  handleAppUninstalled,
  intentFor,
  isStaleUpdate,
  occurredAtOf,
  subjectIdOf,
  toProductRow,
  type CatalogEventKind,
  type Logger,
  type PosthogCapture,
  type ShopifyProduct,
  type StoredVariant,
} from '@sortiva/core'
import {
  accountScope,
  markWebhookProcessed,
  recordCatalogChanges,
  storedProductState,
  systemScope,
  unprocessedWebhooks,
  upsertProducts,
  type Db,
  type WebhookReceipt,
} from '@sortiva/db'
import { runtimeLogger } from '../runtime/logging'
import { tryWithAccountLock } from '../runtime/lock'
import { registerTask } from '../runtime/tasks'
import type { IngestionDeps } from './deps'
import { SHOPIFY_WEBHOOK_DRAIN_TASK } from './queue'

/**
 * Acting on what Shopify told us, after we have already told Shopify we heard it.
 *
 * The receiver's whole job is to prove the message is genuine, write it down and
 * answer inside five seconds — Shopify retries a slow answer and eventually
 * drops the subscription altogether. Everything that decides anything happens
 * here instead, reading the written-down copy rather than the request body, so a
 * slow decision can never cost us the subscription and a crash mid-decision
 * loses nothing: the row is still there, still unprocessed.
 *
 * Each delivery ends in one of three states. `processed` — we acted on it.
 * `ignored` — it was genuine but there was nothing to do: a store we do not
 * hold, or an edit older than the one we already have. `failed` — something
 * broke, and the row keeps its place for the next pass.
 */

export interface WebhookDrainResult {
  readonly seen: number
  readonly processed: number
  readonly ignored: number
  readonly failed: number
}

export interface WebhookDrainDeps {
  readonly ingestion: () => IngestionDeps
  readonly analytics?: PosthogCapture
  readonly logger?: Logger
  readonly now?: () => Date
}

/**
 * Works through the deliveries nobody has acted on yet, oldest first.
 *
 * Oldest first because two edits to one product must land in the order the
 * merchant made them; the out-of-order guard below catches the rest, where
 * Shopify's own delivery order was wrong.
 */
export async function drainShopifyWebhooks(
  deps: WebhookDrainDeps,
  options: { limit?: number } = {},
): Promise<WebhookDrainResult> {
  const ingestion = deps.ingestion()
  const log = deps.logger ?? runtimeLogger()
  const now = deps.now ?? (() => new Date())
  const system = systemScope('the webhook drain works across every store that wrote to us')

  const waiting = await unprocessedWebhooks(ingestion.db, system, options.limit ?? 100)
  let processed = 0
  let ignored = 0
  let failed = 0

  for (const receipt of waiting) {
    try {
      const outcome = await handleReceipt(deps, ingestion, receipt, now())
      const settled = await markWebhookProcessed(ingestion.db, system, receipt.webhookId, {
        status: outcome,
      })
      // Losing that guard means another worker got there first. Its answer
      // stands; ours is discarded rather than written over the top.
      if (!settled) continue
      if (outcome === 'processed') processed += 1
      else ignored += 1

      deps.analytics?.capture({
        event: 'webhook_processed',
        attribution: accountAttribution(outcome === 'processed' ? shopOf(receipt) : 'system'),
        properties: {
          topic: receipt.topic,
          outcome,
          // How far behind we are. A rising figure means the drain is not
          // keeping up, which is what the alert on this event watches for.
          lag_ms: now().getTime() - receipt.receivedAt.getTime(),
        },
      })
    } catch (error) {
      failed += 1
      await markWebhookProcessed(ingestion.db, system, receipt.webhookId, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
      log.error('shopify_webhook_failed', {
        topic: receipt.topic,
        webhook_id: receipt.webhookId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  log.info('shopify_webhooks_drained', { seen: waiting.length, processed, ignored, failed })
  return { seen: waiting.length, processed, ignored, failed }
}

type Outcome = 'processed' | 'ignored'

async function handleReceipt(
  deps: WebhookDrainDeps,
  ingestion: IngestionDeps,
  receipt: WebhookReceipt,
  at: Date,
): Promise<Outcome> {
  const log = deps.logger ?? runtimeLogger()
  const intent = intentFor(receipt.topic)
  if (!intent) return 'ignored'

  const shopHandle = shopOf(receipt)
  const body = bodyOf(receipt)

  if (intent.kind === 'privacy') {
    // The two customer requests are answerable without looking anything up,
    // because there is nothing to look up: order ingestion keeps no customer
    // field. `shop/redact` is recorded for the account-lifecycle owner; erasing
    // a store's data is that surface's job, not this one's.
    log.info('shopify_privacy_request', {
      topic: receipt.topic,
      shop_handle: shopHandle,
      answer: intent.request === 'shop_redact' ? 'recorded_for_lifecycle' : NO_CUSTOMER_DATA_HELD,
    })
    return 'processed'
  }

  // Asked of the same port the uninstall path uses, which answers with the
  // *live* connection only: since wave 4 two rows can carry one store handle,
  // one dead and one live, and answering with the abandoned one would act on an
  // account that no longer has that store.
  const accountId = shopHandle
    ? await ingestion.domains.findAccountByShopHandle(shopHandle)
    : undefined
  if (!accountId) {
    // A store nobody here holds. Normal — an uninstall from a shop that was
    // connected to a different account, or a leftover subscription.
    return 'ignored'
  }

  if (intent.kind === 'connection_lost') {
    await handleAppUninstalled(
      {
        domains: ingestion.domains,
        connections: ingestion.connections,
        ...(ingestion.notifications ? { notifications: ingestion.notifications } : {}),
      },
      {
        shopHandle: shopHandle!,
        at,
        attribution: (id: string) => accountAttribution(id),
      },
    )
    return 'processed'
  }

  // Everything below writes this store's own rows, so it takes the store's lock
  // — the same one the sync and the sweep take. A webhook burst arriving while
  // the nightly walk is running waits its turn rather than interleaving with it.
  const outcome = await tryWithAccountLock(ingestion.pool, accountId, async () => {
    if (intent.kind === 'catalog_product_compare') {
      return compareProduct(ingestion, accountId, shopHandle!, body, at)
    }
    return recordSimpleChange(ingestion, accountId, shopHandle!, receipt, body, intent.events, at)
  })

  // The store is busy. Leaving the row unprocessed hands it to the next pass,
  // which is exactly what we want: no worker parks on a lock.
  if (outcome === undefined) {
    throw new Error('the store was busy with other work; this delivery waits for the next pass')
  }
  return outcome
}

/**
 * A product edit, whose meaning has to be worked out rather than read off the
 * topic — a rewrite, a price change and a sale of the last one in stock all
 * arrive as `products/update`.
 */
async function compareProduct(
  ingestion: IngestionDeps,
  accountId: string,
  shopHandle: string,
  body: Record<string, unknown>,
  at: Date,
): Promise<Outcome> {
  const scope = accountScope(accountId)
  const system = systemScope('a product change is recorded for every consumer of the stream')
  const row = toProductRow(body as unknown as ShopifyProduct)
  if (!row.shopifyProductId) return 'ignored'

  const stored = await storedProductState(ingestion.db, scope, row.shopifyProductId)

  // Shopify redelivers and reorders as a matter of course. An edit older than
  // the one we hold would otherwise overwrite the newer one, and our copy would
  // disagree with the merchant's own admin until the nightly sweep repaired it.
  if (isStaleUpdate(stored?.updatedAt ?? null, row.updatedAt)) return 'ignored'

  const kinds = classifyProductChange(
    stored
      ? {
          checksum: stored.checksum,
          updatedAt: stored.updatedAt,
          variants: (stored.variants ?? []) as readonly StoredVariant[],
        }
      : undefined,
    row,
  )

  await upsertProducts(ingestion.db, scope, [row], at)
  if (kinds.length === 0) return 'processed'

  await recordCatalogChanges(
    ingestion.db,
    system,
    kinds.map((kind: CatalogEventKind) => ({
      accountId,
      shopHandle,
      kind,
      entityId: row.shopifyProductId,
      occurredAt: (row.updatedAt ?? at).toISOString(),
      changedFields: [],
    })),
  )
  return 'processed'
}

/** Every other catalogue topic, whose meaning the topic itself already gives. */
async function recordSimpleChange(
  ingestion: IngestionDeps,
  accountId: string,
  shopHandle: string,
  receipt: WebhookReceipt,
  body: Record<string, unknown>,
  kinds: readonly CatalogEventKind[],
  at: Date,
): Promise<Outcome> {
  const entityId = subjectIdOf(receipt.topic, body)
  if (!entityId) return 'ignored'

  const system = systemScope('a store change is recorded for every consumer of the stream')
  await recordCatalogChanges(
    ingestion.db,
    system,
    kinds.map((kind) => ({
      accountId,
      shopHandle,
      kind,
      entityId,
      occurredAt: occurredAtOf(body, at),
      changedFields: [],
    })),
  )
  return 'processed'
}

/**
 * The store a delivery came from.
 *
 * Shopify names it in a header rather than in the body, so the receiver keeps it
 * alongside the body when it writes the row down — there being no column for it
 * and a feature card adding none.
 */
function shopOf(receipt: WebhookReceipt): string {
  const payload = receipt.payload as Record<string, unknown>
  const handle = payload['shop_handle']
  return typeof handle === 'string' ? handle : ''
}

function bodyOf(receipt: WebhookReceipt): Record<string, unknown> {
  const payload = receipt.payload as Record<string, unknown>
  const body = payload['body']
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
}

let registered = false

/**
 * Puts the drain on the queue's task list.
 *
 * The receiver queues one of these per store as it answers, so a burst of forty
 * edits is one pass rather than forty jobs.
 */
export function registerShopifyWebhookTasks(deps: WebhookDrainDeps): void {
  if (registered) return
  registered = true
  registerTask(SHOPIFY_WEBHOOK_DRAIN_TASK, async () => {
    await drainShopifyWebhooks(deps)
  })
}

/** Test-only: the task registry is a module singleton, and so is this latch. */
export function resetShopifyWebhookTaskRegistration(): void {
  registered = false
}

/** Exposed for the receiver's own synchronous drain in tests. */
export type { Db }

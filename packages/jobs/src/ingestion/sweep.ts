import {
  accountAttribution,
  accumulateOrders,
  classifyProductChange,
  drainLandingDays,
  emptyAggregate,
  toProductRow,
  type CatalogEventKind,
  type Logger,
  type PosthogCapture,
  type ProductRow,
  type ShopifyOrder,
  type ShopifyProduct,
  type StoredVariant,
} from '@sortiva/core'
import {
  accountScope,
  accountsWithLiveShopifyConnectionAndHandle,
  productsNotSyncedSince,
  recordCatalogChanges,
  storedProductStates,
  systemScope,
  upsertLandingRevenue,
  upsertProducts,
} from '@sortiva/db'
import { runtimeLogger } from '../runtime/logging'
import { tryWithAccountLock } from '../runtime/lock'
import { registerTask } from '../runtime/tasks'
import type { IngestionDeps, ShopifyListReader } from './deps'
import { readProductMetafields } from './metafields'
import {
  CATALOG_RECONCILE_TASK,
  LANDING_REVENUE_TASK,
  RECONCILIATION_SWEEP_TASK,
  enqueueCatalogReconcile,
  enqueueLandingRevenue,
} from './queue'

/**
 * The nightly re-read of every connected store.
 *
 * Webhooks drop. Not occasionally — routinely, and silently: a delivery that
 * times out is retried a few times and then abandoned, and nothing tells us it
 * happened. So the webhooks are the fast path and this is the truthful one. It
 * asks the store what it has, compares it against what we hold, and records the
 * differences into the same change stream a webhook would have.
 *
 * Everything about it is a diff rather than an action, which is what makes
 * running it twice converge: the second pass finds nothing different, records
 * nothing, and leaves the same rows behind.
 */

/** Shopify's own ceiling on a list request. */
const PAGE_SIZE = 250

/**
 * How many Shopify requests one run makes before handing the rest back to the
 * queue.
 *
 * At one request a second this is about two minutes of work. A store with more
 * than this many products finishes over several runs of the same night. It
 * decides nothing a merchant sees.
 *
 * Counted in requests rather than pages because a page is no longer one
 * request: a product whose fingerprint moved since we last looked costs a
 * second one for its metafields, so on the night a merchant re-imports their
 * whole catalogue a page can cost two hundred and fifty-one.
 */
const REQUESTS_PER_RUN = 120

const PRODUCT_FIELDS =
  'id,title,body_html,handle,product_type,vendor,tags,status,updated_at,variants,options,images'
const ORDER_FIELDS = 'id,created_at,currency,total_price,landing_site,cancelled_at,test,line_items'

export interface SweepDeps {
  readonly ingestion: () => IngestionDeps
  readonly analytics?: PosthogCapture
  readonly logger?: Logger
  readonly now?: () => Date
  /**
   * The store's own pages, re-read on the same clock and the same budget. Owned
   * by the inventory lane; called from here because the spec puts one nightly
   * pass over a store in one place.
   */
  readonly syncInventory?: () => Promise<unknown>
}

export interface ReconcileResult {
  readonly productsSeen: number
  /** How many differences this pass found. A spike means the webhooks are failing. */
  readonly diffCount: number
  readonly finished: boolean
  readonly cursor?: string
}

/**
 * One store, one pass.
 *
 * The walk is resumable through the queue: a run that hits its page budget hands
 * the cursor back and the next run continues, which is the same shape the
 * inventory walk uses.
 */
export async function reconcileStoreCatalog(
  deps: SweepDeps,
  payload: { accountId: string; cursor?: string; startedAt?: string },
): Promise<ReconcileResult | undefined> {
  const ingestion = deps.ingestion()
  const now = deps.now ?? (() => new Date())
  const scope = accountScope(payload.accountId)
  const system = systemScope('the nightly sweep records changes for every consumer of the stream')

  const connection = await ingestion.connections.read(payload.accountId)
  const token = await ingestion.connections.readToken(payload.accountId)
  if (!connection || connection.invalidatedAt !== null || !token) return undefined
  const admin = ingestion.admin
  if (!admin) return undefined

  const auth = { shop: connection.shopHandle, accessToken: token }
  // The moment the walk began, carried across runs — and also the stamp every
  // product this walk sees is given. Making the two the same value is what makes
  // "which products did the store stop listing" answerable exactly: after the
  // walk, a product still carrying an older stamp is one Shopify did not show
  // us. Comparing against wall-clock instead would depend on the walk taking
  // measurable time, which for a small store it does not.
  const startedAt = payload.startedAt ? new Date(payload.startedAt) : now()

  const known = new Map<string, { checksum: string | null; updatedAt: Date | null; variants: readonly StoredVariant[] }>()
  for (const [shopifyId, record] of await storedProductStates(ingestion.db, scope)) {
    known.set(shopifyId, {
      checksum: record.checksum,
      updatedAt: record.updatedAt,
      variants: (record.variants ?? []) as readonly StoredVariant[],
    })
  }

  let cursor = payload.cursor
  let productsSeen = 0
  let diffCount = 0

  let requests = 0

  while (requests < REQUESTS_PER_RUN) {
    const path = cursor
      ? `products.json?limit=${PAGE_SIZE}&page_info=${encodeURIComponent(cursor)}`
      : `products.json?limit=${PAGE_SIZE}&fields=${PRODUCT_FIELDS}`
    const answer = await readPage<{ products?: ShopifyProduct[] }>(admin, auth, path)
    requests += 1
    const batch = (answer.body.products ?? []).map(toProductRow)
    productsSeen += batch.length

    const changes = batch.flatMap((row) => {
      const kinds = classifyProductChange(known.get(row.shopifyProductId), row)
      return kinds.map((kind: CatalogEventKind) => ({
        accountId: payload.accountId,
        shopHandle: connection.shopHandle,
        kind,
        entityId: row.shopifyProductId,
        // The merchant's own edit time, so a change a webhook already reported
        // produces the same key here and is recorded once, not twice.
        occurredAt: (row.updatedAt ?? now()).toISOString(),
        changedFields: [],
      }))
    })

    // A request of its own per product, so only for the ones whose fingerprint
    // moved. On an ordinary night that is a handful, and the walk itself stays
    // two requests for a small store.
    const enriched: ProductRow[] = []
    for (const row of batch) {
      const stored = known.get(row.shopifyProductId)
      if (stored && stored.checksum === row.checksum) {
        enriched.push(row)
        continue
      }
      const metafields = await readProductMetafields(admin, auth, row.shopifyProductId, (reason) =>
        (deps.logger ?? runtimeLogger()).info('catalog_sweep.metafields_skipped', {
          account_id: payload.accountId,
          shopify_product_id: row.shopifyProductId,
          reason,
        }),
      )
      requests += 1
      enriched.push(metafields === undefined ? row : { ...row, metafields })
    }

    // Written whether or not anything changed: the stamp is what tells the
    // deletion check below which products the store still lists.
    await upsertProducts(ingestion.db, scope, enriched, startedAt)
    diffCount += await recordCatalogChanges(ingestion.db, system, changes)

    for (const row of batch) {
      known.set(row.shopifyProductId, {
        checksum: row.checksum,
        updatedAt: row.updatedAt,
        variants: row.variants,
      })
    }

    cursor = answer.nextPageInfo
    if (!cursor) {
      diffCount += await recordDeletions(deps, payload.accountId, connection.shopHandle, startedAt, now())
      return { productsSeen, diffCount, finished: true }
    }
  }

  return { productsSeen, diffCount, finished: false, cursor }
}

/**
 * Products the store stopped listing.
 *
 * The row is kept rather than deleted. It is the only record that the product
 * ever existed, and the drift rules need exactly that: an article recommending
 * a product that is gone has to be repairable, which means knowing what it
 * pointed at. Removing the row would leave a dangling reference and no way to
 * explain it. What happens to the row afterwards is the drift card's to decide.
 */
async function recordDeletions(
  deps: SweepDeps,
  accountId: string,
  shopHandle: string,
  startedAt: Date,
  at: Date,
): Promise<number> {
  const ingestion = deps.ingestion()
  const scope = accountScope(accountId)
  const system = systemScope('the nightly sweep records removals for every consumer of the stream')
  const gone = await productsNotSyncedSince(ingestion.db, scope, startedAt)
  if (gone.length === 0) return 0

  return recordCatalogChanges(
    ingestion.db,
    system,
    gone.map((product) => ({
      accountId,
      shopHandle,
      kind: 'product_deleted' as const,
      entityId: product.shopifyProductId,
      // A deletion has no edit time of its own, so the sweep's own clock names
      // it. Running the sweep again finds the same product still missing and
      // records a second removal — which the change consumers collapse, because
      // a page removed twice is removed once.
      occurredAt: at.toISOString(),
      changedFields: [],
    })),
  )
}

/**
 * Yesterday's takings per landing page, for every connected store.
 *
 * Separate from the ninety-day pass the onboarding sync does: that one exists to
 * fill in history, this one keeps it current at the cost of a single day's
 * orders. Nothing reads either yet — V1 captures revenue and shows none of it.
 */
export async function aggregateLandingRevenue(
  deps: SweepDeps,
  payload: { accountId: string; days?: number },
): Promise<{ days: number } | undefined> {
  const ingestion = deps.ingestion()
  const now = deps.now ?? (() => new Date())
  const scope = accountScope(payload.accountId)

  const connection = await ingestion.connections.read(payload.accountId)
  const token = await ingestion.connections.readToken(payload.accountId)
  if (!connection || connection.invalidatedAt !== null || !token) return undefined
  const admin = ingestion.admin
  if (!admin) return undefined

  const auth = { shop: connection.shopHandle, accessToken: token }
  const since = new Date(now().getTime() - (payload.days ?? 1) * 86_400_000)

  let aggregate = emptyAggregate()
  let cursor: string | undefined
  for (let page = 0; page < REQUESTS_PER_RUN; page += 1) {
    const path = cursor
      ? `orders.json?limit=${PAGE_SIZE}&page_info=${encodeURIComponent(cursor)}`
      : `orders.json?limit=${PAGE_SIZE}&status=any&order=created_at+asc` +
        `&created_at_min=${encodeURIComponent(since.toISOString())}&fields=${ORDER_FIELDS}`
    const answer = await readPage<{ orders?: ShopifyOrder[] }>(admin, auth, path)
    aggregate = accumulateOrders(aggregate, answer.body.orders ?? [])
    cursor = answer.nextPageInfo
    if (!cursor) break
  }

  // A replace per day, so running this twice over the same orders writes the
  // same numbers rather than adding them again.
  const rows = drainLandingDays(aggregate).map((row) => ({
    date: row.day,
    landingUrl: row.landingUrl,
    ordersN: row.orders,
    revenue: row.revenue,
    currency: row.currency,
  }))
  await upsertLandingRevenue(ingestion.db, scope, rows)
  return { days: rows.length }
}

/**
 * Starts a pass for every store we can still read.
 *
 * The stores are queued rather than walked here: one job per store means a store
 * whose read fails does not take the others down with it, and each pass takes
 * that store's own lock.
 */
export async function runReconciliationSweep(deps: SweepDeps): Promise<{ accounts: number }> {
  const ingestion = deps.ingestion()
  const log = deps.logger ?? runtimeLogger()
  const stores = await accountsWithLiveShopifyConnectionAndHandle(
    ingestion.db,
    systemScope('the nightly sweep chooses which stores to work for'),
  )
  const startedAt = (deps.now ?? (() => new Date()))().toISOString()

  for (const store of stores) {
    await enqueueCatalogReconcile(ingestion.db, { accountId: store.accountId, startedAt })
    await enqueueLandingRevenue(ingestion.db, { accountId: store.accountId })
  }

  // The store's own pages, on the same clock. Owned by the inventory lane.
  await deps.syncInventory?.()

  log.info('reconciliation_sweep_started', { accounts: stores.length })
  return { accounts: stores.length }
}

async function readPage<T>(
  admin: ShopifyListReader,
  auth: { shop: string; accessToken: string },
  path: string,
): Promise<{ body: T; nextPageInfo: string | undefined }> {
  return admin.getPage<T>(auth, path)
}

let registered = false

export function registerCatalogSweepTasks(deps: SweepDeps): void {
  if (registered) return
  registered = true

  registerTask(RECONCILIATION_SWEEP_TASK, async () => {
    await runReconciliationSweep(deps)
  }, 'fans_out')

  registerTask(CATALOG_RECONCILE_TASK, async (rawPayload, helpers) => {
    const payload = rawPayload as { accountId: string; cursor?: string; startedAt?: string }
    const ingestion = deps.ingestion()
    const log = deps.logger ?? runtimeLogger()

    const outcome = await tryWithAccountLock(ingestion.pool, payload.accountId, async () =>
      reconcileStoreCatalog(deps, payload),
    )

    // The store is busy with its own onboarding or a webhook burst. Handed back
    // to the queue rather than parking a worker on a lock: a catalogue a minute
    // out of date costs nothing.
    if (outcome === undefined) {
      await helpers.addJob(CATALOG_RECONCILE_TASK, payload, {
        runAt: new Date(Date.now() + 60_000),
      })
      return
    }
    if (outcome === null || outcome === undefined) return

    if (!outcome.finished) {
      await helpers.addJob(CATALOG_RECONCILE_TASK, {
        ...payload,
        cursor: outcome.cursor,
        startedAt: payload.startedAt,
      })
      return
    }

    // The metric §14.7 asks for. A spike in the number of differences a sweep
    // finds means the webhooks are not arriving, which is invisible any other
    // way — a webhook that never comes raises nothing.
    deps.analytics?.capture({
      event: 'reconciliation_swept',
      attribution: accountAttribution(payload.accountId),
      properties: { diff_count: outcome.diffCount, products_seen: outcome.productsSeen },
    })
    log.info('reconciliation_swept', {
      account_id: payload.accountId,
      diff_count: outcome.diffCount,
      products_seen: outcome.productsSeen,
    })
  }, 'per_account')

  registerTask(LANDING_REVENUE_TASK, async (rawPayload) => {
    const payload = rawPayload as { accountId: string; days?: number }
    const ingestion = deps.ingestion()
    await tryWithAccountLock(ingestion.pool, payload.accountId, async () =>
      aggregateLandingRevenue(deps, payload),
    )
  }, 'per_account')
}

/** Test-only: the task registry is a module singleton, and so is this latch. */
export function resetCatalogSweepTaskRegistration(): void {
  registered = false
}

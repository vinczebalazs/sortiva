import {
  ORDER_WINDOW_DAYS,
  accumulateOrders,
  classifyProductChange,
  drainLandingDays,
  emptyAggregate,
  rankTopProducts,
  settleLandingDays,
  toProductRow,
  type CatalogEventKind,
  type OrderAggregate,
  type ProductRow,
  type ShopifyAuth,
  type StoredVariant,
} from '@sortiva/core'
import {
  accountScope,
  productIdsByShopifyId,
  recordCatalogChanges,
  replaceTopProducts,
  storedProductStates,
  systemScope,
  upsertLandingRevenue,
  upsertProducts,
  type Db,
} from '@sortiva/db'
import { RetryableFailure, TerminalFailure, TokenInvalidFailure } from '../runtime/errors'
import { inputVersion } from '../runtime/idempotency'
import type { StepContext } from '../runtime/runStep'
import type { IngestionDeps, ShopifyListReader } from './deps'
import type { StepDefinition } from './steps'

/**
 * Reading a merchant's whole store: every product, and sixty days of orders.
 *
 * This is the longest thing the product does over a network. A large catalogue
 * is minutes of paced requests, and a busy store's
 * order history is longer, so the step is built on the assumption that it will
 * be interrupted: a deploy, a crash, a killed container.
 *
 * What makes that survivable is that the position is committed after every
 * single page. A worker that dies resumes at the page it reached, not at the
 * first one — which for a merchant is the difference between onboarding
 * finishing tonight and starting again from nothing.
 *
 * Nothing here is billed by anyone. Shopify reads are free and freely
 * retryable, which is why there is no request cache in this step: the thing a
 * cache would protect against — paying twice for one answer — cannot happen.
 * The expensive steps that follow are the ones that need it.
 */

/**
 * How many Shopify requests one run of the step makes before handing the rest
 * back.
 *
 * A page of products is one request and carries its variants and attributes
 * with it, so this is far more of a store than it used to be. Raising it makes
 * a large store finish in fewer runs and each run longer; it decides nothing a
 * merchant sees.
 */
const REQUESTS_PER_RUN = 500

/** Where a run of the step got to. Committed after every page. */
export interface CatalogSyncCheckpoint {
  readonly phase: 'products' | 'orders'
  /** Shopify's cursor into the product list. */
  readonly productPage?: string
  readonly productsSeen: number
  readonly changesRecorded: number
  /** Shopify's cursor into the order list. */
  readonly orderPage?: string
  /** Running totals. Bounded by the catalogue's size plus the days not yet written out. */
  readonly aggregate?: OrderAggregate
  readonly ordersSeen: number
  /** Set when Shopify refused the order read, so a resumed run does not ask again. */
  readonly ordersUnavailable?: boolean
}

export interface CatalogSyncOutput {
  readonly productsSeen: number
  readonly ordersSeen: number
  readonly changesRecorded: number
  readonly topProducts: number
  /**
   * True when Shopify would not let us read the store's orders. Onboarding
   * carries on without best sellers rather than stopping, and this is what the
   * merchant is told about.
   */
  readonly ordersUnavailable?: boolean
}

/**
 * Step three: the catalogue, the best sellers, and the pages buyers arrive on.
 *
 * Its idempotency key is the store plus the day, so a redelivery of the same
 * night's work returns the stored answer instead of walking the store again,
 * while tomorrow's run is genuinely different work. A key over the store alone
 * would make the second night a no-op and the catalogue would never change
 * again; a random key would walk the store twice for one merchant.
 */
export const catalogSyncStep: StepDefinition = {
  async inputVersion(deps, accountId) {
    const connection = await deps.connections.read(accountId)
    if (!connection) throw new TerminalFailure('no_connection', 'No Shopify connection to read.')
    const day = (deps.now?.() ?? new Date()).toISOString().slice(0, 10)
    return inputVersion({ shop: connection.shopHandle, day })
  },

  async execute(deps, rawCtx): Promise<CatalogSyncOutput> {
    // The step registry is untyped in its checkpoint — different steps save
    // different shapes — so the shape this one saves is named here, once.
    const ctx = rawCtx as StepContext<CatalogSyncCheckpoint>
    const auth = await storeAuth(deps, ctx.accountId)
    const admin = requireAdmin(deps)
    const scope = accountScope(ctx.accountId)
    const system = systemScope('the catalogue sync records changes for every consumer of the stream')

    let state: CatalogSyncCheckpoint = ctx.checkpoint ?? {
      phase: 'products',
      productsSeen: 0,
      changesRecorded: 0,
      ordersSeen: 0,
    }

    if (state.phase === 'products') {
      state = await syncProducts(deps, ctx, { auth, admin, scope, system, state })
    }
    if (state.phase === 'orders') {
      state = await syncOrders(deps, ctx, { auth, admin, scope, state })
    }

    const ranked = await writeTopProducts(deps.db, scope, state.aggregate ?? emptyAggregate())

    ctx.log.info('catalog_sync.completed', {
      products_seen: state.productsSeen,
      orders_seen: state.ordersSeen,
      changes_recorded: state.changesRecorded,
      top_products: ranked,
      orders_unavailable: state.ordersUnavailable === true,
    })

    return {
      productsSeen: state.productsSeen,
      ordersSeen: state.ordersSeen,
      changesRecorded: state.changesRecorded,
      topProducts: ranked,
      ...(state.ordersUnavailable ? { ordersUnavailable: true } : {}),
    }
  },
}

interface SyncArgs {
  readonly auth: ShopifyAuth
  readonly admin: ShopifyListReader
  readonly scope: ReturnType<typeof accountScope>
  readonly state: CatalogSyncCheckpoint
}

async function syncProducts(
  deps: IngestionDeps,
  ctx: StepContext<CatalogSyncCheckpoint>,
  args: SyncArgs & { system: ReturnType<typeof systemScope> },
): Promise<CatalogSyncCheckpoint> {
  let state = args.state
  // Read once for the whole walk: the alternative is a query per product, which
  // for a thousand-product store is a thousand round trips to learn what one
  // query already knows.
  const known = new Map<string, ComparableProduct>()
  for (const [shopifyId, record] of await storedProductStates(deps.db, args.scope)) {
    known.set(shopifyId, {
      checksum: record.checksum,
      updatedAt: record.updatedAt,
      variants: (record.variants ?? []) as readonly StoredVariant[],
    })
  }
  const shopHandle = args.auth.shop
  let requests = 0

  while (requests < REQUESTS_PER_RUN) {
    stopIfShuttingDown(ctx)

    const answer = await withTokenInvalidRouting(() =>
      args.admin.listProducts(args.auth, state.productPage ? { after: state.productPage } : {}),
    )
    requests += 1
    const batch = answer.items.map(toProductRow)

    const changes = batch.flatMap((row) =>
      changesFor(
        { accountId: ctx.accountId, shopHandle, now: deps.now?.() ?? new Date() },
        known.get(row.shopifyProductId),
        row,
      ),
    )

    await upsertProducts(deps.db, args.scope, batch, deps.now?.() ?? new Date())
    const recorded = await recordCatalogChanges(deps.db, args.system, changes)

    // Refresh what we hold, so a product appearing twice inside one walk is
    // compared against what we just wrote rather than against what we started
    // with.
    for (const row of batch) {
      known.set(row.shopifyProductId, {
        checksum: row.checksum,
        updatedAt: row.updatedAt,
        variants: row.variants,
      })
    }

    state = {
      ...state,
      productsSeen: state.productsSeen + batch.length,
      changesRecorded: state.changesRecorded + recorded,
      ...(answer.next
        ? { productPage: answer.next }
        : { phase: 'orders' as const, productPage: undefined }),
    }
    // The position is committed on its own, after the page it describes has
    // been written. A crash between the two costs one page re-read, which is
    // free and lands on the rows it already wrote; the other order would skip a
    // page of the merchant's catalogue silently.
    await ctx.save(state)

    if (!answer.next) return state
  }

  // Out of budget with the store unfinished. The step is retried and picks the
  // walk up at the cursor.
  throw new RetryableFailure(
    'catalog_sync_budget',
    `Read ${state.productsSeen} products and the store has more; continuing on the next attempt.`,
  )
}

async function syncOrders(
  deps: IngestionDeps,
  ctx: StepContext<CatalogSyncCheckpoint>,
  args: SyncArgs,
): Promise<CatalogSyncCheckpoint> {
  let state = args.state
  let aggregate = state.aggregate ?? emptyAggregate()
  const since = new Date((deps.now?.() ?? new Date()).getTime() - ORDER_WINDOW_DAYS * 86_400_000)

  for (let page = 0; page < REQUESTS_PER_RUN; page += 1) {
    stopIfShuttingDown(ctx)

    let answer
    try {
      answer = await withTokenInvalidRouting(() =>
        args.admin.listOrders(args.auth, {
          createdFrom: since,
          ...(state.orderPage ? { after: state.orderPage } : {}),
        }),
      )
    } catch (error) {
      if (!isAccessDenied(error)) throw error
      // Shopify treats everything about an order as customer data and approves
      // access to it store by store. Until that approval comes through, this
      // store has a catalogue and no best sellers — which is worth having, and
      // far better than onboarding stopping at a wall the merchant cannot climb.
      ctx.log.warn('catalog_sync.orders_unavailable', {
        reason: error instanceof Error ? error.message : 'Shopify refused the order read',
      })
      state = { ...state, ordersUnavailable: true, orderPage: undefined }
      await ctx.save(state)
      return state
    }

    aggregate = accumulateOrders(aggregate, answer.items, answer.timeZone)

    const { settled, remaining } = settleLandingDays(aggregate)
    await upsertLandingRevenue(deps.db, args.scope, toLandingRows(settled))
    aggregate = remaining

    state = {
      ...state,
      ordersSeen: aggregate.ordersSeen,
      aggregate,
      ...(answer.next ? { orderPage: answer.next } : { orderPage: undefined }),
    }
    await ctx.save(state)

    if (!answer.next) {
      // The last day has no later day to close it, so it is written out here.
      await upsertLandingRevenue(deps.db, args.scope, toLandingRows(drainLandingDays(aggregate)))
      return state
    }
  }

  throw new RetryableFailure(
    'catalog_sync_budget',
    `Read ${state.ordersSeen} orders and the store has more; continuing on the next attempt.`,
  )
}

/**
 * Writes the best-seller list.
 *
 * Runs after the walk rather than during it, because a ranking computed over
 * half the window would be wrong rather than incomplete, and a merchant reading
 * "your best sellers" deserves the finished answer or none.
 */
async function writeTopProducts(
  db: Db,
  scope: ReturnType<typeof accountScope>,
  aggregate: OrderAggregate,
): Promise<number> {
  const ranked = rankTopProducts(aggregate)
  if (ranked.length === 0) return 0
  const ids = await productIdsByShopifyId(
    db,
    scope,
    ranked.map((entry) => entry.shopifyProductId),
  )
  const rows = ranked
    // A best seller the store has since deleted has no product row to point at.
    // Dropped rather than written with a dangling reference.
    .filter((entry) => ids.has(entry.shopifyProductId))
    .map((entry, index) => ({
      productId: ids.get(entry.shopifyProductId)!,
      title: entry.title,
      url: null,
      revenue90d: entry.revenue,
      qty90d: entry.quantity,
      rank: index + 1,
    }))
  await replaceTopProducts(db, scope, rows)
  return rows.length
}

function toLandingRows(
  settled: readonly { day: string; landingUrl: string; orders: number; revenue: number; currency: string }[],
) {
  return settled.map((row) => ({
    date: row.day,
    landingUrl: row.landingUrl,
    ordersN: row.orders,
    revenue: row.revenue,
    currency: row.currency,
  }))
}

/** What the change comparison needs to know about a product we already hold. */
interface ComparableProduct {
  readonly checksum: string | null
  readonly updatedAt: Date | null
  readonly variants: readonly StoredVariant[]
}

/**
 * The changes one product's new description amounts to.
 *
 * The moment recorded is the merchant's own edit time rather than now, which is
 * what makes the change's identity stable: the nightly sweep re-finding an edit
 * a webhook already reported produces the same key and writes nothing.
 */
export function changesFor(
  store: { accountId: string; shopHandle: string; now: Date },
  stored: ComparableProduct | undefined,
  row: ProductRow,
) {
  const kinds = classifyProductChange(stored, row)
  const occurredAt = (row.updatedAt ?? store.now).toISOString()
  return kinds.map((kind: CatalogEventKind) => ({
    accountId: store.accountId,
    shopHandle: store.shopHandle,
    kind,
    entityId: row.shopifyProductId,
    occurredAt,
    changedFields: [],
  }))
}

/**
 * A deploy is not a crash, but it ends the process just as firmly. Stopping on
 * the shutdown signal means the position committed a moment ago is the position
 * the next worker starts from, rather than the step being killed mid-page.
 */
function stopIfShuttingDown(ctx: StepContext<CatalogSyncCheckpoint>): void {
  if (ctx.signal.aborted) {
    throw new RetryableFailure(
      'shutting_down',
      'The process is shutting down; the walk resumes from its saved position.',
    )
  }
}

export async function storeAuth(deps: IngestionDeps, accountId: string): Promise<ShopifyAuth> {
  const auth = await deps.connections.authFor(accountId)
  if (!auth) {
    throw new TerminalFailure('no_connection', 'This store has no working Shopify connection.')
  }
  return auth
}

/** Shopify refused this particular read, rather than the token as a whole. */
export function isAccessDenied(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { errorClass?: unknown }).errorClass === 'shopify_access_denied'
  )
}

function requireAdmin(deps: IngestionDeps): ShopifyListReader {
  if (!deps.admin) {
    throw new TerminalFailure(
      'no_admin_client',
      'The catalogue sync needs a Shopify list reader; the process did not supply one.',
    )
  }
  return deps.admin
}

/**
 * Provider errors carry their own classification but cannot extend the job
 * runtime's failure classes. A dead token has to become the runtime's own class
 * here, because that is what routes the store to the reconnect screen instead of
 * the dead-letter queue.
 */
async function withTokenInvalidRouting<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (
      error instanceof Error &&
      (error as { errorClass?: unknown }).errorClass === 'shopify_token_invalid'
    ) {
      throw new TokenInvalidFailure('shopify', error.message, { cause: error })
    }
    throw error
  }
}

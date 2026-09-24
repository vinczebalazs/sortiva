import type {
  InventorySyncDeps,
  InventorySyncResult,
  InventoryTarget,
  Logger,
  ShopArticleOfOurs,
  ShopifyAuth,
} from '@sortiva/core'
import {
  articleIdFromIntentExternalId,
  resyncInventoryTargets,
  syncInventoryBatch,
} from '@sortiva/core'
import {
  accountScope,
  accountsWithLiveShopifyConnection,
  familyIdsByShopifyProductId,
  followOurArticleRename,
  markStorePagesGoneNotSeenSince,
  markStorePagesOurs,
  markStorePagesSeen,
  publishedArticleAddresses,
  shopPostsWePublished,
  storePageChecksums,
  systemScope,
  upsertStorePages,
  type Db,
} from '@sortiva/db'
import { tryWithAccountLock } from '../runtime/lock'
import { runtimeLogger } from '../runtime/logging'
import { registerTask } from '../runtime/tasks'
import { closeSuggestionsForGonePages } from './gone-suggestions'
import { ShopifyInventorySource } from './source'
import { INVENTORY_SYNC_TASK, enqueueInventorySync, type InventorySyncPayload } from './queue'
import type { InventoryTaskDeps } from './deps'

/**
 * Keeping our picture of what a store publishes up to date.
 *
 * The picture is what the Opportunity Engine consults before proposing a new
 * page: if the store already has a collection for "waterproof walking boots",
 * the work is to improve that page, not to publish a second one competing with
 * it. That check is only as good as this inventory is current.
 */

/**
 * How many of a store's pages one run reads before handing the rest back to the
 * queue.
 *
 * Shopify answers about one request a second and every page costs two of them,
 * so this is roughly a four-minute run. Raising it makes a large store finish in
 * fewer nights and makes each run longer; lowering it does the reverse. It
 * decides nothing a merchant sees.
 */
const PAGES_PER_RUN = 100

export function registerInventoryTasks(deps: InventoryTaskDeps): void {
  if (registered) return
  registered = true

  registerTask(INVENTORY_SYNC_TASK, async (rawPayload, helpers) => {
    const payload = rawPayload as InventorySyncPayload
    const outcome = await tryWithAccountLock(deps.getPool(), payload.accountId, async () =>
      runInventorySync(deps, payload),
    )

    // The account is busy with something else. Hand the same work back to the
    // queue rather than parking a worker slot on a lock: an inventory that is a
    // minute out of date costs nothing.
    if (outcome === undefined) {
      await helpers.addJob(INVENTORY_SYNC_TASK, payload, { runAt: new Date(Date.now() + 60_000) })
      return
    }

    if (outcome.status === 'more') {
      await helpers.addJob(INVENTORY_SYNC_TASK, {
        accountId: payload.accountId,
        cursor: outcome.cursor,
      } satisfies InventorySyncPayload)
    }
  }, 'per_account')
}

export type InventorySyncStatus =
  | { readonly status: 'done'; readonly result: InventorySyncResult }
  | { readonly status: 'more'; readonly cursor: Readonly<Record<string, string>>; readonly result: InventorySyncResult }
  /** The store's connection is gone. Recorded; the rest of the store's work carries on. */
  | { readonly status: 'disconnected' }

/**
 * One store, one run.
 *
 * Either re-reads the handful of things a webhook named, or advances the walk
 * through the whole store by one batch. A walk that has more to do says so, and
 * the caller queues the rest.
 */
export async function runInventorySync(
  deps: InventoryTaskDeps,
  payload: InventorySyncPayload,
): Promise<InventorySyncStatus> {
  const log = deps.logger ?? runtimeLogger()
  const db = deps.getDb()
  const auth = await deps.connections.authFor(payload.accountId)
  if (!auth) {
    log.info('inventory_sync_skipped', { account_id: payload.accountId, reason: 'not_connected' })
    return { status: 'disconnected' }
  }

  const syncDeps = inventoryDeps(deps, db, auth)

  try {
    if (payload.targets && payload.targets.length > 0) {
      const result = await resyncInventoryTargets(
        syncDeps,
        payload.accountId,
        payload.targets as readonly InventoryTarget[],
      )
      logResult(log, payload.accountId, result, 'targets')
      return { status: 'done', result }
    }

    const result = await syncInventoryBatch(
      syncDeps,
      payload.accountId,
      payload.cursor,
      PAGES_PER_RUN,
    )
    logResult(log, payload.accountId, result, 'walk')
    if (result.next) return { status: 'more', cursor: result.next, result }

    // Only the batch that reached the end of the store gets here, which is the
    // same thing that lets a page be marked gone at all. A suggestion about a
    // page the merchant has deleted cannot be acted on, so it comes down on the
    // night we find out rather than waiting for the weekly detection pass.
    await closeSuggestionsForGonePages(
      { db, ...(deps.now ? { now: deps.now } : {}), logger: log },
      payload.accountId,
    )
    return { status: 'done', result }
  } catch (error) {
    // A dead token is not a retryable failure — only the merchant can fix it —
    // and it is not a reason to stop the rest of this store's work either. It is
    // recorded, and the reconnect prompt is raised by whoever owns the
    // connection.
    if (isTokenInvalid(error)) {
      await deps.connections.markInvalid(payload.accountId, (deps.now ?? (() => new Date()))())
      log.info('inventory_sync_skipped', { account_id: payload.accountId, reason: 'token_invalid' })
      return { status: 'disconnected' }
    }
    throw error
  }
}

/**
 * Starts a walk for every connected store.
 *
 * Meant to be called from the nightly reconciliation sweep, which is where the
 * spec puts this work — one clock, one budget, one place that decides a store
 * has been looked at today. Until that sweep exists, this is how the walk is
 * started.
 */
export async function sweepInventory(deps: InventoryTaskDeps): Promise<{ accounts: number }> {
  const db = deps.getDb()
  const accountIds = await accountsWithLiveShopifyConnection(
    db,
    systemScope('the nightly inventory sweep chooses which stores to work for'),
  )
  for (const accountId of accountIds) {
    await enqueueInventorySync(db, { accountId })
  }
  return { accounts: accountIds.length }
}

/**
 * Binds the inventory's four ports to this store: where its pages come from,
 * where its rows go, which of the store's addresses hold articles we published,
 * and which family each of its products is in.
 */
function inventoryDeps(
  deps: InventoryTaskDeps,
  db: Db,
  auth: ShopifyAuth,
): InventorySyncDeps {
  const source = new ShopifyInventorySource(deps.admin, async () => auth)
  return {
    source,
    writer: {
      knownChecksums: (accountId, urls) => storePageChecksums(db, accountScope(accountId), urls),
      upsert: async (accountId, rows) => {
        await upsertStorePages(
          db,
          accountScope(accountId),
          rows,
          (deps.now ?? (() => new Date()))(),
        )
      },
      markSeen: (accountId, urls, at) =>
        markStorePagesSeen(db, accountScope(accountId), urls, at),
      markGoneNotSeenSince: (accountId, since) =>
        markStorePagesGoneNotSeenSince(db, accountScope(accountId), since),
      markOurs: async (accountId, pages) => {
        await markStorePagesOurs(db, accountScope(accountId), pages)
      },
    },
    ourArticles: {
      publishedArticles: (accountId) => publishedArticleAddresses(db, accountScope(accountId)),
      publishedToShop: (accountId) => shopPostsWePublished(db, accountScope(accountId)).then(ourPosts),
    },
    articleAddresses: {
      followRename: async (accountId, move) => {
        await followOurArticleRename(db, accountScope(accountId), move, (deps.now ?? (() => new Date()))())
      },
    },
    families: {
      familiesForProducts: (accountId, ids) =>
        familyIdsByShopifyProductId(db, accountScope(accountId), ids),
    },
    ...(deps.now ? { now: deps.now } : {}),
  }
}

/**
 * Which article each post on the shop came from.
 *
 * A publication claim is named after the article it was made for, and the name
 * is the only thing joining the two — there is no column pointing one at the
 * other. Unpacking the name is the article pipeline's own business, so this
 * borrows its reader rather than teaching a query the shape of the name. A name
 * that reader does not recognise is dropped, because a wrong article here would
 * move the wrong page's address.
 */
function ourPosts(
  claims: readonly { readonly articleExternalId: string; readonly shopifyArticleId: string }[],
): readonly ShopArticleOfOurs[] {
  return claims.flatMap((claim) => {
    const articleId = articleIdFromIntentExternalId(claim.articleExternalId)
    return articleId ? [{ articleId, shopifyArticleId: claim.shopifyArticleId }] : []
  })
}

function logResult(
  log: Logger,
  accountId: string,
  result: InventorySyncResult,
  mode: 'walk' | 'targets',
): void {
  log.info('inventory_synced', {
    account_id: accountId,
    mode,
    seen: result.seen,
    changed: result.changed,
    finished: mode === 'walk' ? result.next === undefined : true,
    // Only the batch that finished a walk carries this, and a sudden large
    // number is the shape of a walk that went wrong rather than a merchant
    // clearing out their store.
    ...(result.markedGone === undefined ? {} : { marked_gone: result.markedGone }),
    // Two finished behaviours are dormant while this stays at zero for a store
    // we have published to, so it is worth being able to see from outside.
    marked_ours: result.markedOurs,
    // A merchant renaming one of our posts. Rare, and each one moved an address
    // a merchant may have linked to from somewhere we cannot see.
    followed_renames: result.followedRenames,
  })
}

/**
 * A token Shopify refused, and one it will no longer renew, are the same news to
 * this job: only the merchant can fix either. Recognised by the class the
 * provider stamps on both rather than by name, so a third way of losing a grant
 * does not quietly become a retryable failure.
 */
function isTokenInvalid(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { errorClass?: unknown }).errorClass === 'shopify_token_invalid'
  )
}

let registered = false

/** Test-only: the task registry is a module singleton, and so is this latch. */
export function resetInventoryTaskRegistration(): void {
  registered = false
}

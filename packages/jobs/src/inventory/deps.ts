import type pg from 'pg'
import type { Db } from '@sortiva/db'
import type { Logger, ShopifyAuth, StoreContentKind, StoreContentRecord } from '@sortiva/core'

/**
 * What the inventory job reaches outside itself.
 *
 * Ports rather than concrete clients, so the whole walk can be driven against a
 * stand-in store — which is the only way to test it at all, there being no
 * Partner account and no dev store.
 */

/**
 * The one Shopify Admin client the product has, narrowed to what this job does
 * with it. Reading the store's own record, and reading lists it publishes.
 *
 * Deliberately not a second client: a second one would be a second set of
 * retry, rate-limit and dead-token behaviours, and only one of them would get
 * fixed when Shopify changed something.
 */
export interface ShopifyAdminReader {
  /**
   * One page of the store's published things of one kind, and the store's own
   * marker for where the next page begins — absent at the end of the list.
   */
  listContent(
    auth: ShopifyAuth,
    options: { kind: StoreContentKind; after?: string; first?: number },
  ): Promise<{ items: readonly StoreContentRecord[]; next: string | undefined }>
  /**
   * One thing by the store's own id. Undefined means the store genuinely no
   * longer publishes it — anything else is a failure and is raised.
   */
  readContent(
    auth: ShopifyAuth,
    target: { kind: StoreContentKind; shopifyId: string },
  ): Promise<StoreContentRecord | undefined>
  collectionMemberIds(
    auth: ShopifyAuth,
    collectionId: string,
    first?: number,
  ): Promise<readonly string[]>
  getShop(auth: ShopifyAuth): Promise<{
    readonly myshopifyDomain: string
    readonly primaryDomain: string | null
  }>
}

/** Where the store's credentials live, decrypted at the edge by the caller. */
export interface ShopifyCredentials {
  readonly shopHandle: string
  readonly accessToken: string
}

export interface InventoryConnectionStore {
  /**
   * How to reach one store: its handle, and a token renewed as it ages.
   * Undefined when there is no working connection to reach it with.
   *
   * A token asked for per request rather than handed over once, because a walk
   * through a large store outlasts the hour a Shopify token lives.
   */
  authFor(accountId: string): Promise<ShopifyAuth | undefined>
  markInvalid(accountId: string, at: Date): Promise<unknown>
}

export interface InventoryTaskDeps {
  readonly getDb: () => Db
  /** Advisory locks need a connection they can hold for the length of a step. */
  readonly getPool: () => pg.Pool
  readonly admin: ShopifyAdminReader
  readonly connections: InventoryConnectionStore
  readonly now?: () => Date
  readonly logger?: Logger
}

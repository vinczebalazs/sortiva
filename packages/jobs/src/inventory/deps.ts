import type pg from 'pg'
import type { Db } from '@sortiva/db'
import type { Logger } from '@sortiva/core'

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
  get<T>(input: { shop: string; accessToken: string }, path: string): Promise<T>
}

/** Where the store's credentials live, decrypted at the edge by the caller. */
export interface ShopifyCredentials {
  readonly shopHandle: string
  readonly accessToken: string
}

export interface InventoryConnectionStore {
  read(accountId: string): Promise<{ shopHandle: string } | undefined>
  /** The decrypted token, for a caller about to make a call with it. */
  readToken(accountId: string): Promise<string | undefined>
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

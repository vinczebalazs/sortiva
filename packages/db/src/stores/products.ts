import { db, type Db } from '../client'
import { listCatalogProducts, type CatalogProductRow } from '../repositories/catalog'
import { findShopifyConnForAccount } from '../repositories/accounts'
import { productSubstanceForFamilies, type ProductSubstanceRow } from '../repositories/distill'
import { listCompletedMerchantTasks, listOpenOpportunities } from '../repositories/opportunities'
import type { OpportunityRow } from '../repositories/opportunities'
import { makeProfileStore, type ProfileFamily } from './profile'
import type { AccountScope } from '../scope'

/**
 * Everything the Products screen reads, in one place.
 *
 * Four different questions about one store — what is in the catalogue, how it
 * is grouped, what work is being held up for want of product detail, and where
 * the merchant would go to fix it — asked separately because they are answered
 * by four different tables and the screen asks them all in one glance.
 *
 * A store rather than a bag of loose functions for the reason the profile store
 * gives: the route that needs these must not hold a raw database handle, and
 * the handle here is resolved on the call rather than at construction, so a
 * build that evaluates the module without a database configured does not fail.
 */

export interface ProductsStoreOptions {
  /** An integration test hands in its own isolated database; production uses the pool. */
  database?: Db
}

export interface ProductsStore {
  /** Every product in the store, with its fact sheet where one has been distilled. */
  catalog(scope: AccountScope): Promise<CatalogProductRow[]>
  /** The read-only family list, in the same shape the confirmation screen reads. */
  families(scope: AccountScope): Promise<ProfileFamily[]>
  /** Every opportunity still open, which the merchant tasks are filtered out of. */
  openOpportunities(scope: AccountScope): Promise<OpportunityRow[]>
  /** The holds the merchant themselves cleared, newest first, for the completed section. */
  completedMerchantTasks(scope: AccountScope): Promise<OpportunityRow[]>
  /** The distilled products behind a set of families, for the substance floor to judge. */
  substanceForFamilies(
    scope: AccountScope,
    familyIds: readonly string[],
  ): Promise<ProductSubstanceRow[]>
  /**
   * The store's Shopify handle, or null when there is no connection to build a
   * link from. Deliberately just the handle: nothing on this screen needs the
   * token, and returning the row would put ciphertext within reach of a
   * response serialiser.
   */
  shopHandle(scope: AccountScope): Promise<string | null>
}

export function makeProductsStore(options: ProductsStoreOptions = {}): ProductsStore {
  const database = (): Db => options.database ?? db()
  const profile = makeProfileStore(options)

  return {
    catalog: (scope) => listCatalogProducts(database(), scope),
    families: (scope) => profile.families(scope),
    openOpportunities: (scope) => listOpenOpportunities(database(), scope),
    completedMerchantTasks: (scope) => listCompletedMerchantTasks(database(), scope),
    substanceForFamilies: (scope, familyIds) =>
      productSubstanceForFamilies(database(), scope, familyIds),

    async shopHandle(scope) {
      const row = await findShopifyConnForAccount(database(), scope)
      return row?.shopHandle ?? null
    },
  }
}

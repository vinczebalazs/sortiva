import { db, type Db } from '../client'
import { articleLibraryRows, type ArticleRow } from '../repositories/articles'
import { listStorePages, type StorePageRow } from '../repositories/inventory'
import {
  listAppliedOpportunities,
  listOpenOpportunities,
  type OpportunityRow,
} from '../repositories/opportunities'
import {
  findGscConnForAccount,
  gscDayTotals,
  gscPageTotals,
  gscQueryTotals,
  latestGscDay,
  type GscConnRow,
  type GscDayTotal,
  type GscKeyTotal,
  type GscWindow,
} from '../repositories/search'
import type { AccountScope } from '../scope'

/**
 * Everything the two Performance screens read, in one place.
 *
 * A store rather than loose functions for the reason the products store gives:
 * the routes that need these must not hold a raw database handle, and the
 * handle here is resolved on the call rather than at construction — so a build
 * step that evaluates every route module without a database configured does not
 * turn into a server whose every route answers 500.
 */

export interface PerformanceStoreOptions {
  /** An integration test hands in its own isolated database; production uses the pool. */
  database?: Db
}

export interface PerformanceStore {
  /** The Search Console connection row, or undefined when the merchant never granted one. */
  connection(scope: AccountScope): Promise<GscConnRow | undefined>
  /** The last day this store has any search data at all, which is where the chart stops. */
  latestDay(scope: AccountScope): Promise<string | null>
  /** Store-wide clicks and impressions per day, for the chart. */
  daily(scope: AccountScope, window: GscWindow): Promise<GscDayTotal[]>
  /** Per-page totals over a window, for the pages table and for attributing articles. */
  pages(scope: AccountScope, window: GscWindow): Promise<GscKeyTotal[]>
  /** Per-search totals over a window, for the queries table. */
  queries(scope: AccountScope, window: GscWindow): Promise<GscKeyTotal[]>
  /** Every article this store has had written; the caller keeps the published ones. */
  articles(scope: AccountScope): Promise<readonly ArticleRow[]>
  /** The store's own pages, which is where a page's type and title come from. */
  storePages(scope: AccountScope): Promise<StorePageRow[]>
  /** Still-open opportunities, which is what puts a signal badge on a table row. */
  openOpportunities(scope: AccountScope): Promise<OpportunityRow[]>
  /** Opportunities the merchant marked applied — a chart marker each, and a results row each. */
  appliedOpportunities(scope: AccountScope): Promise<OpportunityRow[]>
}

export function makePerformanceStore(options: PerformanceStoreOptions = {}): PerformanceStore {
  const database = (): Db => options.database ?? db()

  return {
    connection: (scope) => findGscConnForAccount(database(), scope),
    latestDay: (scope) => latestGscDay(database(), scope),
    daily: (scope, window) => gscDayTotals(database(), scope, window),
    pages: (scope, window) => gscPageTotals(database(), scope, window),
    queries: (scope, window) => gscQueryTotals(database(), scope, window),
    storePages: (scope) => listStorePages(database(), scope),
    openOpportunities: (scope) => listOpenOpportunities(database(), scope),
    appliedOpportunities: (scope) => listAppliedOpportunities(database(), scope),

    /**
     * The article library read, which answers two questions this screen does not
     * ask — how often a piece has been rewritten, and whether anything was ever
     * repaired on it. Both are small indexed lookups over ids already in hand,
     * and calling it costs less than a second listing of the same table would.
     */
    async articles(scope) {
      const rows = await articleLibraryRows(database(), scope)
      return rows.map((row) => row.article)
    },
  }
}

import type { IntentClass, QueryCluster } from '../contracts/opportunities'
import type { StorePageType } from '../signals/types'

/**
 * What the existing-target check needs to know about a store, and nothing else.
 *
 * Kept as plain data rather than as a database handle so the rule itself is a
 * function of its inputs: the same store description always produces the same
 * answer, and the answer can be read off a table in a test instead of inferred
 * from a fixture database.
 */

/**
 * Whether the store still publishes an address we hold a row for.
 *
 * Today this is `unknown` for every row, and that is a gap somebody has to
 * close rather than a state we chose. A merchant who deletes a collection
 * leaves its inventory row behind and nothing records that it went — the
 * marker needs a database column, and adding one is a schema wave. Until it
 * lands the check reads `unknown` as "still there", which is the safe
 * direction: mistaking a live page for a dead one is what makes us publish a
 * second page competing with it, and that is the one failure this whole check
 * exists to prevent. Mistaking a dead page for a live one costs a suggestion
 * the merchant will dismiss.
 */
export type PagePresence = 'published' | 'removed' | 'unknown'

/** One address the store publishes, as the check needs to see it. */
export interface ExistingTargetPage {
  readonly url: string
  readonly pageType: StorePageType
  /**
   * What the searcher landing here is trying to do. Null where nothing has
   * worked it out yet, which today is every page: the column exists and no
   * code writes it. Null is treated as "we do not know", never as "no".
   */
  readonly intentClass: IntentClass | null
  readonly familyIds: readonly string[]
  readonly presence: PagePresence
}

/**
 * One of the store's own pages as Search Console reports it for this intent,
 * with the days already summed.
 */
export interface ClusterRankedPage {
  readonly url: string
  readonly impressions: number
  /** Search Console's mean position, a fraction. Null when the page was never shown. */
  readonly position: number | null
}

/**
 * One position the paid search vendor says this domain holds, used only when
 * the store has no Search Console connection.
 *
 * It is a weaker reading than Search Console's — a third party's sample rather
 * than Google's own record of what it showed — which is why an opportunity
 * resting on it carries a confidence penalty and names the proxy in its
 * evidence.
 */
export interface ProxyRankedKeyword {
  readonly keyword: string
  readonly url: string
  readonly position: number
}

/**
 * Everything the check reads for one candidate intent.
 *
 * Assembled by the caller — the weekly scan or the topic gate — so the rule
 * itself makes no queries and no vendor calls, and the cost of running it is
 * visible where the data is gathered rather than hidden inside the decision.
 */
export interface ExistingTargetInput {
  readonly cluster: QueryCluster
  /**
   * Search Console rows for this intent over the check's window. Empty for a
   * store with no connection, which is what sends the check to the fallback.
   */
  readonly rankedPages: readonly ClusterRankedPage[]
  /** Every address the store publishes, from the content inventory. */
  readonly pages: readonly ExistingTargetPage[]
  /** The vendor's account of what this domain ranks for. Read only in limited mode. */
  readonly proxyRankings: readonly ProxyRankedKeyword[]
  /** True when the store has no Search Console connection at all. */
  readonly limitedIntelligence: boolean
  readonly config: ExistingTargetConfig
  /** When the underlying data was read. Passed in, never taken from the clock. */
  readonly fetchedAt: string
}

/** The two numbers this rule turns on, both from `packages/rules`. */
export interface ExistingTargetConfig {
  readonly window_days: number
  readonly match_position_max: number
}

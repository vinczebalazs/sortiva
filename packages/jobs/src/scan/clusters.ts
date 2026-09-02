import type { Logger } from '@sortiva/core'
import { buildQueryClusters, toIsoDate } from '@sortiva/core'
import {
  accountScope,
  confirmedKeywordTerms,
  findGscConnForAccount,
  gscPageQueryTotals,
  upsertQueryClusters,
  type Db,
} from '@sortiva/db'
import { rules } from '@sortiva/rules'
import { runtimeLogger } from '../runtime/logging'

/**
 * Rebuilding the intents a store is actually searched for.
 *
 * Detection reasons about intents rather than about single searches: a page is
 * judged on the thing it serves, not on one spelling of it, and two of the
 * store's own pages splitting one intent between them is only visible once the
 * spellings are pooled.
 *
 * Deliberately **not** on a schedule of its own. Clusters have to be current at
 * the moment the weekly signal scan reads them, and that scan is a different
 * lane's card; building them an hour after it ran would have every scan working
 * from week-old clusters. Exported for the scan to call, in the same way the
 * inventory walk waits for the sweep that owns it.
 */

export interface ClusterRebuildDeps {
  readonly db: Db
  readonly now?: () => Date
  readonly logger?: Logger
}

export type ClusterRebuildOutcome =
  | { readonly status: 'rebuilt'; readonly clusters: number; readonly inserted: number; readonly updated: number }
  /** No Search Console connection, so there are no searches to pool. */
  | { readonly status: 'not_connected' }

export async function rebuildQueryClustersForAccount(
  deps: ClusterRebuildDeps,
  accountId: string,
): Promise<ClusterRebuildOutcome> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(accountId)

  const connection = await findGscConnForAccount(deps.db, scope)
  if (!connection || connection.property === '') return { status: 'not_connected' }

  const config = rules().defaults.clusters
  const searchConsole = rules().defaults.search_console

  const end = new Date(now)
  end.setUTCDate(end.getUTCDate() - searchConsole.data_lag_days)
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - config.window_days + 1)

  const totals = await gscPageQueryTotals(
    deps.db,
    scope,
    { startDate: toIsoDate(start), endDate: toIsoDate(end) },
    config.min_query_impressions,
  )

  // The same search on three pages is one search to a cluster; the split across
  // pages is what the share table is for, not what the pooling is about.
  const perQuery = new Map<string, { query: string; clicks: number; impressions: number }>()
  for (const row of totals) {
    const existing = perQuery.get(row.query)
    if (existing) {
      existing.clicks += row.clicks
      existing.impressions += row.impressions
      continue
    }
    perQuery.set(row.query, { query: row.query, clicks: row.clicks, impressions: row.impressions })
  }

  const clusters = buildQueryClusters({
    queries: [...perQuery.values()],
    config,
    preferredHeads: await confirmedKeywordTerms(deps.db, scope),
  })

  const written = await upsertQueryClusters(deps.db, scope, clusters)

  log.info('query_clusters_rebuilt', {
    account_id: accountId,
    clusters: clusters.length,
    inserted: written.inserted,
    updated: written.updated,
    start_date: toIsoDate(start),
    end_date: toIsoDate(end),
  })

  return { status: 'rebuilt', clusters: clusters.length, ...written }
}

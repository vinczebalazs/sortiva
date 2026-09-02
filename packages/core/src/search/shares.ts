import { normaliseQuery } from './clusters'

/**
 * Which of the store's own pages Google shows for each intent, and how much of
 * that intent each page holds.
 *
 * "Share" here means one thing only: of all the times the store was shown for
 * any search in this cluster, what fraction were this page. It is the number two
 * later signals are built on. One page holding almost all of an intent while
 * sitting just off the first page is a page worth improving. Two pages each
 * holding a substantial slice of the *same* intent is the store competing with
 * itself — Google splitting its confidence between two of the merchant's own
 * URLs, so neither wins.
 *
 * Nothing here judges anything. It produces the table; the numbers that decide
 * what counts as "substantial" live in `packages/rules` and are applied by the
 * detectors that read this.
 */

/** One page-by-search row over the window, already totalled across days. */
export interface ClusterShareRow {
  readonly page: string
  readonly query: string
  readonly clicks: number
  readonly impressions: number
  /** Search Console's average position, which is a fraction. Null when nothing was ever shown. */
  readonly position: number | null
}

export interface ClusterDefinition {
  readonly headQuery: string
  readonly memberQueries: readonly string[]
  /** Present once the cluster has been stored; absent while it is still a draft. */
  readonly clusterId?: string
}

export interface PageShare {
  readonly page: string
  readonly clicks: number
  readonly impressions: number
  /** Impression-weighted mean position across every search in the cluster this page was shown for. */
  readonly position: number | null
  /** This page's impressions as a fraction of the whole cluster's. Sums to 1 across the cluster. */
  readonly impressionShare: number
}

export interface ClusterShares {
  readonly headQuery: string
  readonly clusterId?: string
  readonly clicks: number
  readonly impressions: number
  readonly position: number | null
  /** Every page the store was shown for on this intent, biggest share first. */
  readonly pages: readonly PageShare[]
}

interface Accumulator {
  clicks: number
  impressions: number
  positionWeight: number
  positionWeightBase: number
}

function emptyAccumulator(): Accumulator {
  return { clicks: 0, impressions: 0, positionWeight: 0, positionWeightBase: 0 }
}

function add(into: Accumulator, row: ClusterShareRow): void {
  into.clicks += row.clicks
  into.impressions += row.impressions
  if (row.position !== null && row.impressions) {
    into.positionWeight += row.position * row.impressions
    into.positionWeightBase += row.impressions
  }
}

/**
 * Average position is a mean over impressions, so combining rows means
 * re-dividing accumulated weight by accumulated impressions. Returning null when
 * nothing was ever shown is deliberate: zero would read as "ranked first", which
 * is the opposite of what happened.
 */
function meanPosition(acc: Accumulator): number | null {
  return acc.positionWeightBase === 0 ? null : acc.positionWeight / acc.positionWeightBase
}

/**
 * Builds the page-by-cluster table for one store.
 *
 * A search belonging to two clusters is counted in both. That cannot happen with
 * clusters built by `buildQueryClusters`, which assigns each search to exactly
 * one head — but clusters can also arrive from a topic's stored lineage, and two
 * of those may legitimately overlap. Counting into both is the honest reading:
 * each cluster's shares are about that cluster, and they still sum to 1 within it.
 */
export function pageClusterShares(
  clusters: readonly ClusterDefinition[],
  rows: readonly ClusterShareRow[],
): ClusterShares[] {
  const queryToClusters = new Map<string, string[]>()
  for (const cluster of clusters) {
    for (const query of [cluster.headQuery, ...cluster.memberQueries]) {
      const key = normaliseQuery(query)
      if (!key) continue
      const existing = queryToClusters.get(key)
      if (existing) existing.push(cluster.headQuery)
      else queryToClusters.set(key, [cluster.headQuery])
    }
  }

  const totals = new Map<string, Accumulator>()
  const perPage = new Map<string, Map<string, Accumulator>>()
  for (const cluster of clusters) {
    totals.set(cluster.headQuery, emptyAccumulator())
    perPage.set(cluster.headQuery, new Map())
  }

  for (const row of rows) {
    const heads = queryToClusters.get(normaliseQuery(row.query))
    if (!heads) continue
    for (const head of heads) {
      const total = totals.get(head)
      const pages = perPage.get(head)
      if (!total || !pages) continue
      add(total, row)
      const page = pages.get(row.page) ?? emptyAccumulator()
      add(page, row)
      pages.set(row.page, page)
    }
  }

  return clusters.map((cluster) => {
    const total = totals.get(cluster.headQuery) ?? emptyAccumulator()
    const pages = perPage.get(cluster.headQuery) ?? new Map<string, Accumulator>()
    const shares: PageShare[] = [...pages.entries()]
      .map(([page, acc]) => ({
        page,
        clicks: acc.clicks,
        impressions: acc.impressions,
        position: meanPosition(acc),
        // A cluster with no impressions at all has no shares to divide; every
        // page in it holds none of it, which is what zero says here.
        impressionShare: total.impressions ? acc.impressions / total.impressions : 0,
      }))
      .sort((a, b) => b.impressions - a.impressions || a.page.localeCompare(b.page))

    return {
      headQuery: cluster.headQuery,
      ...(cluster.clusterId ? { clusterId: cluster.clusterId } : {}),
      clicks: total.clicks,
      impressions: total.impressions,
      position: meanPosition(total),
      pages: shares,
    }
  })
}

import type { SignalsConfig } from '@sortiva/rules'
import type { EvidenceFact } from '../contracts/opportunities'
import { type ClusterDefinition, type ClusterShareRow, pageClusterShares } from '../search'
import { storeBaseline } from './baseline'
import { strongestPerPage } from './per-page'
import {
  type DetectionResult,
  type DetectionWindow,
  type PageIndex,
  type StorePageType,
  INVENTORY_SOURCE,
  facts,
  normalisePageUrl,
  windowToken,
} from './types'

/**
 * Pages Google already puts near the first page of results.
 *
 * These are the cheapest wins a store has. Google has already decided the page
 * is a relevant answer — it is showing it — and the distance between position
 * eleven and position four is an editing job, not a new page. Anything further
 * back than the band is usually not reachable by editing, and anything already
 * inside the top three has nothing left to gain from this.
 *
 * The traffic floor is what keeps this from being a list of every page in the
 * store: a page nobody is shown for can sit at position five for a search
 * nobody makes, and improving it changes nothing. So the page has to already
 * carry at least as much traffic as this store's middle page.
 */

export interface StrikingDistanceSignal {
  readonly signalType: 'striking_distance'
  readonly page: string
  readonly pageType: StorePageType
  readonly clusterHead: string
  readonly clusterId?: string
  /** The page's mean position on this intent, as Search Console reports it — a fraction, not a rank. */
  readonly position: number
  readonly clusterImpressions: number
  readonly clusterClicks: number
  /** Everything the page was shown for in the window, which is what the store median is compared against. */
  readonly pageImpressions: number
  readonly storeMedianPageImpressions: number
  /** Other intents on this same page that also sit in the band. */
  readonly otherQualifyingClusters: number
  readonly window: DetectionWindow
  readonly evidence: readonly EvidenceFact[]
}

export interface StrikingDistanceInput {
  readonly clusters: readonly ClusterDefinition[]
  /** Page-by-search totals over the window. */
  readonly rows: readonly ClusterShareRow[]
  readonly pages: PageIndex
  readonly config: SignalsConfig['striking_distance']
  readonly window: DetectionWindow
  /** When the search data was read. Passed in, never taken from the clock, so a detector is a function of its inputs. */
  readonly fetchedAt: string
}

interface Candidate {
  readonly page: string
  readonly clusterHead: string
  readonly clusterId?: string
  readonly clusterImpressions: number
  readonly clusterClicks: number
  readonly position: number
  readonly pageImpressions: number
}

export function detectStrikingDistance(
  input: StrikingDistanceInput,
): DetectionResult<StrikingDistanceSignal> {
  const { config, window } = input
  const baseline = storeBaseline(input.rows, input.pages)
  const storeMedian = baseline.medianImpressions

  // No rated pages means no yardstick. Judging a store against a middle that
  // does not exist would be inventing a bar rather than measuring against one.
  if (storeMedian === null) {
    return { detections: [], unknownPages: baseline.unknownPages }
  }

  const impressionsFloor = storeMedian * config.impressions_store_median_multiple_min
  const candidates: Candidate[] = []

  for (const cluster of pageClusterShares(input.clusters, input.rows)) {
    for (const share of cluster.pages) {
      const page = normalisePageUrl(share.page)
      if (!input.pages.has(page)) continue
      if (share.position === null) continue
      if (share.position < config.position_min) continue
      if (share.position > config.position_max) continue
      const totals = baseline.totals.get(page)
      if (!totals) continue
      if (totals.impressions < impressionsFloor) continue

      candidates.push({
        page,
        clusterHead: cluster.headQuery,
        ...(cluster.clusterId ? { clusterId: cluster.clusterId } : {}),
        clusterImpressions: share.impressions,
        clusterClicks: share.clicks,
        position: share.position,
        pageImpressions: totals.impressions,
      })
    }
  }

  const token = windowToken(window)
  const detections = strongestPerPage(candidates).map(({ winner, alsoQualified }) => {
    const pageType = input.pages.get(winner.page)?.pageType ?? 'other'
    return {
      signalType: 'striking_distance' as const,
      page: winner.page,
      pageType,
      clusterHead: winner.clusterHead,
      ...(winner.clusterId ? { clusterId: winner.clusterId } : {}),
      position: winner.position,
      clusterImpressions: winner.clusterImpressions,
      clusterClicks: winner.clusterClicks,
      pageImpressions: winner.pageImpressions,
      storeMedianPageImpressions: storeMedian,
      otherQualifyingClusters: alsoQualified,
      window,
      evidence: facts(input.fetchedAt, [
        { key: 'query_cluster', value: winner.clusterHead, window: token },
        { key: 'position', value: winner.position, window: token },
        { key: 'impressions', value: winner.clusterImpressions, window: token },
        { key: 'clicks', value: winner.clusterClicks, window: token },
        { key: 'page_impressions', value: winner.pageImpressions, window: token },
        { key: 'store_median_page_impressions', value: storeMedian, window: token },
        { key: 'other_qualifying_clusters', value: alsoQualified, window: token },
        { key: 'page_type', value: pageType, source: INVENTORY_SOURCE },
      ]),
    }
  })

  return { detections, unknownPages: baseline.unknownPages }
}

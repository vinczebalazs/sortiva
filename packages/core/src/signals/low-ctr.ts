import type { SignalsConfig } from '@sortiva/rules'
import type { EvidenceFact } from '../contracts/opportunities'
import {
  type ClusterDefinition,
  type ClusterShareRow,
  type CtrCurve,
  type CtrCurveSource,
  expectedCtrAt,
  isBrandedQuery,
  pageClusterShares,
} from '../search'
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
 * Pages that rank well and are not clicked.
 *
 * The ranking is not the problem here — the page is already near the top. What
 * loses the click is what the searcher reads before deciding: the title and the
 * description Google shows. That is a rewrite of two fields, not of a page.
 *
 * The comparison is always against **this store's own** click rate at the same
 * position, never a published industry table. What fraction of people click at
 * position three swings enormously with the device mix, with how much of the
 * traffic is people typing the brand name, and with whatever else Google puts
 * on the results page; a general table would flag half of some stores and none
 * of others for reasons that have nothing to do with their titles.
 *
 * Searches for the store's own name are dropped first, where we can tell which
 * words those are. Somebody searching a shop by name was going to click it
 * whatever the listing said, and leaving them in makes every ordinary page look
 * badly written by comparison.
 */

export interface LowCtrSignal {
  readonly signalType: 'low_ctr_at_strong_rank'
  readonly page: string
  readonly pageType: StorePageType
  readonly clusterHead: string
  readonly clusterId?: string
  readonly position: number
  readonly clusterImpressions: number
  readonly clusterClicks: number
  readonly observedCtr: number
  /** What this store's own curve says a page at this position usually earns. */
  readonly predictedCtr: number
  /** Observed as a fraction of predicted. Below the configured bound is the signal. */
  readonly ctrRatio: number
  /** Whether the curve was fitted from the store's own history or is the fallback table. */
  readonly curveSource: CtrCurveSource
  readonly pageImpressions: number
  readonly storeMedianPageImpressions: number
  readonly brandedExcluded: boolean
  readonly otherQualifyingClusters: number
  readonly window: DetectionWindow
  readonly evidence: readonly EvidenceFact[]
}

export interface LowCtrCurveInput {
  readonly curve: CtrCurve
  readonly source: CtrCurveSource
  /** The curve is fitted over a longer stretch than the signal window, and the evidence says so per fact. */
  readonly windowDays: number
}

export interface LowCtrInput {
  readonly clusters: readonly ClusterDefinition[]
  readonly rows: readonly ClusterShareRow[]
  readonly pages: PageIndex
  readonly curve: LowCtrCurveInput
  /** Words that mean somebody searched for this store by name. Empty means we could not tell, and nothing is excluded. */
  readonly brandTokens?: readonly string[]
  readonly config: SignalsConfig['low_ctr_at_strong_rank']
  readonly window: DetectionWindow
  readonly fetchedAt: string
}

interface Candidate {
  readonly page: string
  readonly clusterHead: string
  readonly clusterId?: string
  readonly clusterImpressions: number
  readonly clusterClicks: number
  readonly position: number
  readonly observedCtr: number
  readonly predictedCtr: number
  readonly ctrRatio: number
  readonly pageImpressions: number
}

export function detectLowCtrAtStrongRank(input: LowCtrInput): DetectionResult<LowCtrSignal> {
  const { config, window } = input
  const brandTokens = input.brandTokens ?? []
  const brandedExcluded = brandTokens.length > 0

  const rows = brandedExcluded
    ? input.rows.filter((row) => !isBrandedQuery(row.query, brandTokens))
    : input.rows

  const baseline = storeBaseline(rows, input.pages)
  const storeMedian = baseline.medianImpressions
  if (storeMedian === null) {
    return { detections: [], unknownPages: baseline.unknownPages }
  }

  const impressionsFloor = storeMedian * config.impressions_store_median_multiple_min
  const candidates: Candidate[] = []

  for (const cluster of pageClusterShares(input.clusters, rows)) {
    for (const share of cluster.pages) {
      const page = normalisePageUrl(share.page)
      if (!input.pages.has(page)) continue
      if (share.position === null) continue
      if (share.position > config.position_max) continue
      if (!share.impressions) continue

      const totals = baseline.totals.get(page)
      if (!totals) continue
      if (totals.impressions < impressionsFloor) continue

      const predictedCtr = expectedCtrAt(input.curve.curve, share.position)
      // A curve with nothing to say at this position cannot be fallen short of.
      if (predictedCtr === null || !predictedCtr) continue

      const observedCtr = share.clicks / share.impressions
      const ctrRatio = observedCtr / predictedCtr
      if (ctrRatio >= config.observed_vs_predicted_ctr_ratio_max) continue

      candidates.push({
        page,
        clusterHead: cluster.headQuery,
        ...(cluster.clusterId ? { clusterId: cluster.clusterId } : {}),
        clusterImpressions: share.impressions,
        clusterClicks: share.clicks,
        position: share.position,
        observedCtr,
        predictedCtr,
        ctrRatio,
        pageImpressions: totals.impressions,
      })
    }
  }

  const token = windowToken(window)
  const curveToken = `${input.curve.windowDays}d`

  const detections = strongestPerPage(candidates).map(({ winner, alsoQualified }) => {
    const pageType = input.pages.get(winner.page)?.pageType ?? 'other'
    return {
      signalType: 'low_ctr_at_strong_rank' as const,
      page: winner.page,
      pageType,
      clusterHead: winner.clusterHead,
      ...(winner.clusterId ? { clusterId: winner.clusterId } : {}),
      position: winner.position,
      clusterImpressions: winner.clusterImpressions,
      clusterClicks: winner.clusterClicks,
      observedCtr: winner.observedCtr,
      predictedCtr: winner.predictedCtr,
      ctrRatio: winner.ctrRatio,
      curveSource: input.curve.source,
      pageImpressions: winner.pageImpressions,
      storeMedianPageImpressions: storeMedian,
      brandedExcluded,
      otherQualifyingClusters: alsoQualified,
      window,
      evidence: facts(input.fetchedAt, [
        { key: 'query_cluster', value: winner.clusterHead, window: token },
        { key: 'position', value: winner.position, window: token },
        { key: 'impressions', value: winner.clusterImpressions, window: token },
        { key: 'clicks', value: winner.clusterClicks, window: token },
        { key: 'observed_ctr', value: winner.observedCtr, window: token },
        // The predicted rate comes from the curve, which is fitted over its own
        // longer window — so it carries that window, not the signal's.
        { key: 'predicted_ctr', value: winner.predictedCtr, window: curveToken },
        { key: 'ctr_curve_source', value: input.curve.source, window: curveToken },
        { key: 'ctr_ratio', value: winner.ctrRatio, window: token },
        { key: 'page_impressions', value: winner.pageImpressions, window: token },
        { key: 'store_median_page_impressions', value: storeMedian, window: token },
        { key: 'branded_queries_excluded', value: String(brandedExcluded), window: token },
        { key: 'page_type', value: pageType, source: INVENTORY_SOURCE },
      ]),
    }
  })

  return { detections, unknownPages: baseline.unknownPages }
}

import type { SignalsConfig } from '@sortiva/rules'
import type { EvidenceFact, IntentClass } from '../contracts/opportunities'
import { type ClusterDefinition, type ClusterShareRow, pageClusterShares } from '../search'
import {
  type DetectionWindow,
  type PageIndex,
  type StorePageType,
  INVENTORY_SOURCE,
  earlierWindowToken,
  facts,
  normalisePageUrl,
  windowToken,
} from './types'

/**
 * The store competing with itself.
 *
 * When a collection, a blog post and a product page all turn up for the same
 * search, Google is splitting its confidence between three of the merchant's
 * own URLs and none of them wins outright. The fix is an editorial one —
 * decide which page is meant to answer that search and point the others at it
 * — and it is worth doing only when it is actually costing something.
 *
 * So two of the store's pages sharing a search is a *candidate*, never a
 * finding. It becomes a finding only when both of these hold:
 *
 * 1. The pages are trying to do the same job. A buying guide and a how-to that
 *    both appear for one search are not competing, they are answering different
 *    people, and telling a merchant to merge them would destroy something that
 *    works. Where we do not know what job a page is doing, we say so and stop —
 *    guessing here means recommending a page be consolidated away.
 * 2. Either the page Google leads with keeps changing week to week — the sign
 *    that it cannot settle on one of ours — or the search is earning the store
 *    fewer clicks than it did a quarter ago.
 *
 * Candidates that fail either half come back separately, with the reason, so
 * the fact that we looked is never lost.
 */

export interface CompetingPage {
  readonly page: string
  readonly pageType: StorePageType
  readonly intentClass: IntentClass | null
  readonly clicks: number
  readonly impressions: number
  /** This page's share of everything the store was shown for on this intent. */
  readonly impressionShare: number
  readonly position: number
}

export type CannibalizationValidation =
  | {
      readonly validated: true
      readonly intentClass: IntentClass
      /** Which half of the test carried it: the leader moving, the clicks falling, or both. */
      readonly via: 'alternation' | 'aggregate_loss' | 'both'
    }
  | {
      readonly validated: false
      readonly reason:
        | 'intent_class_unknown'
        | 'different_intent_class'
        | 'no_alternation_or_loss'
        | 'no_baseline_to_compare'
    }

export interface CannibalizationSignal {
  readonly signalType: 'cannibalization'
  readonly clusterHead: string
  readonly clusterId?: string
  readonly clusterImpressions: number
  readonly clusterClicks: number
  readonly competing: readonly CompetingPage[]
  /** The page Google led with in each week of the window, oldest first. */
  readonly weeklyLeaders: readonly { readonly weekStart: string; readonly page: string }[]
  readonly leaderChanges: number
  /** Clicks on this intent in the same window a quarter earlier. Null when we hold no data that far back. */
  readonly baselineClusterClicks: number | null
  readonly clicksVsBaselineRatio: number | null
  readonly validation: CannibalizationValidation
  readonly window: DetectionWindow
  readonly evidence: readonly EvidenceFact[]
}

export interface CannibalizationResult {
  /** Candidates that passed both halves of the validation. */
  readonly detections: readonly CannibalizationSignal[]
  /** Candidates that did not, each carrying why. Not opportunities; the merchant never sees them. */
  readonly unvalidated: readonly CannibalizationSignal[]
  readonly unknownPages: readonly string[]
}

/** One window's page-by-search totals, tagged with the week they fall in. */
export interface WeeklyShareRow extends ClusterShareRow {
  /** `YYYY-MM-DD` of the first day of the week these totals cover. */
  readonly weekStart: string
}

export interface CannibalizationInput {
  readonly clusters: readonly ClusterDefinition[]
  readonly rows: readonly ClusterShareRow[]
  /** The same rows split by week, which is what "the leader flips week to week" is read from. */
  readonly weeklyRows: readonly WeeklyShareRow[]
  /** The same window a quarter earlier. Absent means that half of the validation cannot be tried. */
  readonly baselineRows?: readonly ClusterShareRow[]
  readonly pages: PageIndex
  readonly config: SignalsConfig['cannibalization']
  readonly window: DetectionWindow
  readonly fetchedAt: string
}

/** The page Google led with in each week, oldest week first. */
function weeklyLeaders(
  cluster: ClusterDefinition,
  weeklyRows: readonly WeeklyShareRow[],
): { weekStart: string; page: string }[] {
  const byWeek = new Map<string, WeeklyShareRow[]>()
  for (const row of weeklyRows) {
    const existing = byWeek.get(row.weekStart)
    if (existing) existing.push(row)
    else byWeek.set(row.weekStart, [row])
  }

  const out: { weekStart: string; page: string }[] = []
  for (const weekStart of [...byWeek.keys()].sort()) {
    const rows = byWeek.get(weekStart) ?? []
    const shares = pageClusterShares([cluster], rows)[0]
    // `pages` is sorted most-shown first by the share table itself.
    const leader = shares?.pages[0]
    if (!leader || !leader.impressions) continue
    out.push({ weekStart, page: normalisePageUrl(leader.page) })
  }
  return out
}

function countLeaderChanges(leaders: readonly { page: string }[]): number {
  let changes = 0
  for (let index = 1; index < leaders.length; index += 1) {
    if (leaders[index]?.page !== leaders[index - 1]?.page) changes += 1
  }
  return changes
}

function sharedIntentClass(competing: readonly CompetingPage[]): CannibalizationValidation {
  const first = competing[0]?.intentClass
  if (!first) return { validated: false, reason: 'intent_class_unknown' }
  for (const page of competing) {
    if (!page.intentClass) return { validated: false, reason: 'intent_class_unknown' }
    if (page.intentClass !== first) return { validated: false, reason: 'different_intent_class' }
  }
  return { validated: true, intentClass: first, via: 'both' }
}

export function detectCannibalization(input: CannibalizationInput): CannibalizationResult {
  const { config, window } = input
  const token = windowToken(window)
  const beforeToken = earlierWindowToken(window, config.baseline_offset_weeks)

  const baselineByCluster = new Map<string, number>()
  if (input.baselineRows) {
    for (const cluster of pageClusterShares(input.clusters, input.baselineRows)) {
      baselineByCluster.set(cluster.headQuery, cluster.clicks)
    }
  }

  const unknownPages = new Set<string>()
  const detections: CannibalizationSignal[] = []
  const unvalidated: CannibalizationSignal[] = []

  for (const cluster of pageClusterShares(input.clusters, input.rows)) {
    const definition = input.clusters.find((row) => row.headQuery === cluster.headQuery)
    if (!definition) continue

    const competing: CompetingPage[] = []
    for (const share of cluster.pages) {
      const page = normalisePageUrl(share.page)
      const fact = input.pages.get(page)
      if (!fact) {
        unknownPages.add(page)
        continue
      }
      if (share.position === null) continue
      if (share.position > config.position_max) continue
      if (share.impressionShare < config.impression_share_min) continue
      competing.push({
        page,
        pageType: fact.pageType,
        intentClass: fact.intentClass,
        clicks: share.clicks,
        impressions: share.impressions,
        impressionShare: share.impressionShare,
        position: share.position,
      })
    }

    if (competing.length < config.competing_urls_min) continue

    const leaders = weeklyLeaders(definition, input.weeklyRows)
    const leaderChanges = countLeaderChanges(leaders)
    const alternates = leaderChanges >= config.leader_changes_min

    const baselineClicks = baselineByCluster.get(cluster.headQuery) ?? null
    const clicksVsBaselineRatio =
      baselineClicks === null || !baselineClicks ? null : cluster.clicks / baselineClicks
    const lostGround =
      clicksVsBaselineRatio !== null &&
      clicksVsBaselineRatio <= config.aggregate_loss_clicks_ratio_max

    let validation = sharedIntentClass(competing)
    if (validation.validated) {
      if (alternates && lostGround) validation = { ...validation, via: 'both' }
      else if (alternates) validation = { ...validation, via: 'alternation' }
      else if (lostGround) validation = { ...validation, via: 'aggregate_loss' }
      else {
        validation =
          clicksVsBaselineRatio === null
            ? { validated: false, reason: 'no_baseline_to_compare' }
            : { validated: false, reason: 'no_alternation_or_loss' }
      }
    }

    const perPageFacts = competing.flatMap((page, index) => [
      { key: `competing_page_${index + 1}`, value: page.page, window: token },
      {
        key: `competing_page_${index + 1}_impression_share`,
        value: page.impressionShare,
        window: token,
      },
      { key: `competing_page_${index + 1}_position`, value: page.position, window: token },
      {
        key: `competing_page_${index + 1}_type`,
        value: page.pageType,
        source: INVENTORY_SOURCE,
      },
    ])

    const signal: CannibalizationSignal = {
      signalType: 'cannibalization',
      clusterHead: cluster.headQuery,
      ...(cluster.clusterId ? { clusterId: cluster.clusterId } : {}),
      clusterImpressions: cluster.impressions,
      clusterClicks: cluster.clicks,
      competing,
      weeklyLeaders: leaders,
      leaderChanges,
      baselineClusterClicks: baselineClicks,
      clicksVsBaselineRatio,
      validation,
      window,
      evidence: facts(input.fetchedAt, [
        { key: 'query_cluster', value: cluster.headQuery, window: token },
        { key: 'competing_urls', value: competing.length, window: token },
        { key: 'cluster_impressions', value: cluster.impressions, window: token },
        { key: 'cluster_clicks', value: cluster.clicks, window: token },
        ...perPageFacts,
        { key: 'weekly_leader_changes', value: leaderChanges, window: token },
        ...(baselineClicks === null
          ? []
          : [{ key: 'baseline_cluster_clicks', value: baselineClicks, window: beforeToken }]),
        ...(clicksVsBaselineRatio === null
          ? []
          : [{ key: 'clicks_vs_baseline_ratio', value: clicksVsBaselineRatio, window: token }]),
        {
          key: 'intent_class',
          value: validation.validated ? validation.intentClass : 'unknown',
          source: INVENTORY_SOURCE,
        },
      ]),
    }

    if (validation.validated) detections.push(signal)
    else unvalidated.push(signal)
  }

  const byImpressions = (a: CannibalizationSignal, b: CannibalizationSignal): number =>
    b.clusterImpressions - a.clusterImpressions || a.clusterHead.localeCompare(b.clusterHead)

  return {
    detections: detections.sort(byImpressions),
    unvalidated: unvalidated.sort(byImpressions),
    unknownPages: [...unknownPages].sort(),
  }
}

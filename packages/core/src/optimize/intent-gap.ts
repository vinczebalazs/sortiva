import type { SignalsConfig } from '@sortiva/rules'
import type { EvidenceFact } from '../contracts/opportunities'
import { type ClusterDefinition, type ClusterShareRow, pageClusterShares } from '../search'
import {
  INVENTORY_SOURCE,
  facts,
  normalisePageUrl,
  type PageIndex,
  type StorePageType,
} from '../signals/types'
import { strongestPerPage } from '../signals/per-page'
import type { ExistingPageIntentGapSignal } from '../opportunities/p1-signal-shapes'
import type { CoverageAnalysis, SubtopicCoverage } from './coverage'
import { gapSet } from './coverage'

/**
 * "We have the right page, but it does not cover what the results page expects."
 *
 * The detection has two halves that cost very different amounts. Working out
 * *which* pages are worth comparing is free — it reads Search Console rows we
 * already hold. Doing the comparison costs a paid results-page read, up to five
 * page fetches and a model call, so it happens only for pages the free half
 * shortlisted. That split is why this file has no I/O in it at all: the
 * shortlist is a filter over rows, and the signal is a function of a comparison
 * somebody else paid for.
 */

/**
 * Where the facts behind a missing subtopic came from.
 *
 * Deliberately not `dataforseo`: the ranking itself is a measurement bought
 * from the search-data vendor, but "this page covers waterproofing and ours
 * does not" is a model's reading of two documents. Anything rendered from
 * these facts should be able to say which of the two it is.
 */
export const COVERAGE_ANALYSIS_SOURCE = 'serp_coverage_analysis'

/** One page worth paying to compare, and what it is being compared *for*. */
export interface IntentGapCandidate {
  readonly page: string
  readonly pageType: StorePageType
  readonly clusterHead: string
  readonly clusterId?: string
  /** Search Console's mean position for this page on this intent, or the best competitor-gap position where that is the reason it was shortlisted. */
  readonly position: number
  readonly clusterImpressions: number
  /** Why this page reached the shortlist, which decides nothing here but travels into the log. */
  readonly reason: 'gsc_position' | 'competitor_gap_target'
  /** Other intents on this same page that also cleared the band. */
  readonly otherQualifyingClusters: number
}

export interface ShortlistIntentGapInput {
  readonly clusters: readonly ClusterDefinition[]
  /** Page-by-search totals over the window. */
  readonly rows: readonly ClusterShareRow[]
  readonly pages: PageIndex
  readonly config: SignalsConfig['existing_page_intent_gap']
  /**
   * Pages the competitor-coverage detector already picked out as the store's
   * existing target for a keyword competitors rank for. §7.3 admits these
   * whatever Search Console says about them, because the reason to compare
   * them came from the results page rather than from our own traffic.
   */
  readonly competitorGapTargets?: readonly {
    readonly page: string
    readonly clusterHead: string
    readonly position: number
    readonly clusterImpressions: number
  }[]
  /** Most pages one run may compare. The caller's daily allowance, never a number chosen here. */
  readonly limit: number
}

/**
 * The free half: which pages are worth paying to compare.
 *
 * One candidate per page, not one per phrasing — a collection sitting just off
 * page one for a dozen wordings of the same thing is one job, and the database
 * would only keep one open opportunity for it anyway.
 */
export function shortlistIntentGapPages(
  input: ShortlistIntentGapInput,
): IntentGapCandidate[] {
  const { config } = input
  const candidates: (IntentGapCandidate & { readonly page: string })[] = []

  for (const cluster of pageClusterShares(input.clusters, input.rows)) {
    for (const share of cluster.pages) {
      const page = normalisePageUrl(share.page)
      const fact = input.pages.get(page)
      if (!fact) continue
      if (share.position === null) continue
      if (share.position < config.position_min) continue
      if (share.position > config.position_max) continue

      candidates.push({
        page,
        pageType: fact.pageType,
        clusterHead: cluster.headQuery,
        ...(cluster.clusterId ? { clusterId: cluster.clusterId } : {}),
        position: share.position,
        clusterImpressions: share.impressions,
        reason: 'gsc_position',
        otherQualifyingClusters: 0,
      })
    }
  }

  for (const target of input.competitorGapTargets ?? []) {
    const page = normalisePageUrl(target.page)
    const fact = input.pages.get(page)
    if (!fact) continue
    candidates.push({
      page,
      pageType: fact.pageType,
      clusterHead: target.clusterHead,
      position: target.position,
      clusterImpressions: target.clusterImpressions,
      reason: 'competitor_gap_target',
      otherQualifyingClusters: 0,
    })
  }

  return strongestPerPage(candidates)
    .map(({ winner, alsoQualified }) => ({ ...winner, otherQualifyingClusters: alsoQualified }))
    .slice(0, Math.max(0, input.limit))
}

export interface BuildIntentGapSignalInput {
  readonly candidate: IntentGapCandidate
  readonly analysis: CoverageAnalysis
  readonly config: SignalsConfig['existing_page_intent_gap']
  /** When the comparison was made. Passed in, never read off the clock, so a detector stays a function of its inputs. */
  readonly analysedAt: string
}

/**
 * Turns one comparison into a signal, or into nothing.
 *
 * Nothing is the common answer and is not a failure: a page that already covers
 * what the results page covers is a page with no work to do, and saying so
 * costs the merchant nothing to read because they never see it.
 */
export function buildIntentGapSignal(
  input: BuildIntentGapSignalInput,
): ExistingPageIntentGapSignal | null {
  const gaps = gapSet(input.analysis.subtopics, input.config.subtopic_present_on_top_pages_min)
  if (gaps.length < input.config.missing_subtopics_min) return null

  const { candidate } = input
  return {
    signalType: 'existing_page_intent_gap',
    page: candidate.page,
    pageType: candidate.pageType,
    clusterHead: candidate.clusterHead,
    position: candidate.position,
    clusterImpressions: candidate.clusterImpressions,
    missingSubtopics: gaps.map((gap) => gap.name),
    evidence: intentGapEvidence({
      candidate,
      gaps,
      topPagesAnalysed: input.analysis.topPagesAnalysed,
      analysedAt: input.analysedAt,
    }),
  }
}

/**
 * The evidence a merchant is shown, one entry per missing subtopic plus the
 * measurements that put the page on the shortlist.
 *
 * Each subtopic contributes three facts under a shared index — its name, how
 * many of the ranking pages settle it, and the headings they settle it under —
 * so a card can pair them without parsing a sentence, and so the merchant can
 * go and read the pages the claim rests on.
 */
function intentGapEvidence(input: {
  readonly candidate: IntentGapCandidate
  readonly gaps: readonly SubtopicCoverage[]
  readonly topPagesAnalysed: number
  readonly analysedAt: string
}): EvidenceFact[] {
  const { candidate } = input
  const perSubtopic = input.gaps.flatMap((gap, index) => {
    const n = index + 1
    return [
      { key: `missing_subtopic_${n}`, value: gap.name, source: COVERAGE_ANALYSIS_SOURCE },
      {
        key: `missing_subtopic_${n}_top_page_count`,
        value: gap.competitors.length,
        source: COVERAGE_ANALYSIS_SOURCE,
      },
      {
        key: `missing_subtopic_${n}_top_page_headings`,
        value: gap.competitors
          .map((citation) => `${citation.url}${citation.heading ? ` — ${citation.heading}` : ''}`)
          .join('; '),
        source: COVERAGE_ANALYSIS_SOURCE,
      },
    ]
  })

  return facts(input.analysedAt, [
    { key: 'query_cluster', value: candidate.clusterHead },
    { key: 'position', value: candidate.position },
    { key: 'impressions', value: candidate.clusterImpressions },
    { key: 'shortlist_reason', value: candidate.reason, source: INVENTORY_SOURCE },
    { key: 'page_type', value: candidate.pageType, source: INVENTORY_SOURCE },
    { key: 'top_pages_analysed', value: input.topPagesAnalysed, source: 'dataforseo' },
    { key: 'missing_subtopic_count', value: input.gaps.length, source: COVERAGE_ANALYSIS_SOURCE },
    ...perSubtopic,
  ])
}

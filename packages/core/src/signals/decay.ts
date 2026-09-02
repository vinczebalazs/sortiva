import type { SignalsConfig } from '@sortiva/rules'
import type { EvidenceFact } from '../contracts/opportunities'
import type { ClusterShareRow } from '../search'
import { storeBaseline } from './baseline'
import {
  type DetectionWindow,
  type PageIndex,
  type StorePageType,
  INVENTORY_SOURCE,
  earlierWindowToken,
  facts,
  windowToken,
} from './types'

/**
 * Pages that used to work and no longer do.
 *
 * Judged entirely against the page's own past — the same four weeks a quarter
 * earlier — because there is no absolute number that means "doing badly". Two
 * things have to have happened together: the clicks have fallen a long way and
 * the page has slipped several places down the results. Either alone is
 * ordinary. Clicks fall when a season ends; positions drift by a place all the
 * time. Both together is a page losing ground.
 *
 * And it has to have been worth something to begin with. A page that never
 * earned clicks has not decayed, it simply never worked, and putting those on
 * the merchant's list would fill it with pages nothing can recover.
 *
 * **One bad week is not a trend.** Search results swing around a holiday, an
 * outage, or one of Google's experiments, and a page can look ruined for seven
 * days and be fine on the eighth. So the same page has to look this way on
 * consecutive weekly runs before it counts. A page seen for the first time
 * comes back as *provisional*: real, recorded, and not yet something the
 * merchant is told about.
 */

export interface ContentDecaySignal {
  readonly signalType: 'content_decay'
  readonly page: string
  readonly pageType: StorePageType
  readonly currentClicks: number
  readonly currentImpressions: number
  readonly currentPosition: number
  readonly baselineClicks: number
  readonly baselineImpressions: number
  readonly baselinePosition: number
  /** Clicks now as a fraction of clicks then. Below the configured bound is half the test. */
  readonly clicksRatio: number
  /** How many places the page has slipped. Positive means worse, because position one is the best. */
  readonly positionWorsenedBy: number
  readonly storeMedianBaselineClicks: number
  /** Counting this run. Below the configured minimum the page is provisional, not reported. */
  readonly consecutiveWeeklyEvaluations: number
  readonly confirmed: boolean
  readonly window: DetectionWindow
  readonly baselineWindow: DetectionWindow
  readonly evidence: readonly EvidenceFact[]
}

export interface ContentDecayResult {
  /** Pages the decline has held for long enough on. */
  readonly detections: readonly ContentDecaySignal[]
  /**
   * Pages that look decayed for the first time (or have not yet held long
   * enough). The caller records these so the next weekly run can count them;
   * they are not opportunities and the merchant never sees them.
   */
  readonly provisional: readonly ContentDecaySignal[]
  readonly unknownPages: readonly string[]
}

export interface ContentDecayInput {
  /** Page-by-search totals over the recent window. */
  readonly rows: readonly ClusterShareRow[]
  /** The same length of window, the configured number of weeks earlier. */
  readonly baselineRows: readonly ClusterShareRow[]
  readonly pages: PageIndex
  readonly config: SignalsConfig['content_decay']
  readonly window: DetectionWindow
  readonly baselineWindow: DetectionWindow
  /**
   * How many *earlier* consecutive weekly runs already found this page
   * decaying, per page URL. Absent or zero means this is the first sighting.
   * Nothing in the product stores this yet — see DECISIONS, 2026-09-02.
   */
  readonly priorConsecutiveEvaluations?: ReadonlyMap<string, number>
  readonly fetchedAt: string
}

export function detectContentDecay(input: ContentDecayInput): ContentDecayResult {
  const { config, window, baselineWindow } = input

  const current = storeBaseline(input.rows, input.pages)
  const baseline = storeBaseline(input.baselineRows, input.pages)
  const medianBaselineClicks = baseline.medianClicks

  const unknownPages = [...new Set([...current.unknownPages, ...baseline.unknownPages])].sort()

  // Without a middle to compare against there is no such thing as "was doing
  // well before", and the signal's whole premise is a page that was.
  if (medianBaselineClicks === null) {
    return { detections: [], provisional: [], unknownPages }
  }

  const clicksFloor = medianBaselineClicks * config.baseline_clicks_store_median_multiple_min
  const token = windowToken(window)
  const beforeToken = earlierWindowToken(window, config.comparison_window_offset_weeks)

  const detections: ContentDecaySignal[] = []
  const provisional: ContentDecaySignal[] = []

  for (const [page, then] of baseline.totals) {
    const fact = input.pages.get(page)
    if (!fact) continue
    // A page with no clicks then cannot have lost any, and dividing by it
    // would answer with an infinity rather than with a finding.
    if (!then.clicks) continue
    if (then.clicks < clicksFloor) continue
    if (then.position === null) continue

    const now = current.totals.get(page)
    if (!now || now.position === null) continue

    const clicksRatio = now.clicks / then.clicks
    if (clicksRatio > config.clicks_ratio_max) continue

    const positionWorsenedBy = now.position - then.position
    if (positionWorsenedBy < config.position_worsened_min) continue

    const consecutive = (input.priorConsecutiveEvaluations?.get(page) ?? 0) + 1
    const confirmed = consecutive >= config.consecutive_weekly_evaluations_min

    const signal: ContentDecaySignal = {
      signalType: 'content_decay',
      page,
      pageType: fact.pageType,
      currentClicks: now.clicks,
      currentImpressions: now.impressions,
      currentPosition: now.position,
      baselineClicks: then.clicks,
      baselineImpressions: then.impressions,
      baselinePosition: then.position,
      clicksRatio,
      positionWorsenedBy,
      storeMedianBaselineClicks: medianBaselineClicks,
      consecutiveWeeklyEvaluations: consecutive,
      confirmed,
      window,
      baselineWindow,
      evidence: facts(input.fetchedAt, [
        { key: 'clicks', value: now.clicks, window: token },
        { key: 'impressions', value: now.impressions, window: token },
        { key: 'position', value: now.position, window: token },
        { key: 'baseline_clicks', value: then.clicks, window: beforeToken },
        { key: 'baseline_impressions', value: then.impressions, window: beforeToken },
        { key: 'baseline_position', value: then.position, window: beforeToken },
        { key: 'clicks_ratio', value: clicksRatio, window: token },
        { key: 'position_worsened_by', value: positionWorsenedBy, window: token },
        { key: 'store_median_baseline_clicks', value: medianBaselineClicks, window: beforeToken },
        { key: 'consecutive_weekly_evaluations', value: consecutive, window: token },
        { key: 'page_type', value: fact.pageType, source: INVENTORY_SOURCE },
      ]),
    }

    if (confirmed) detections.push(signal)
    else provisional.push(signal)
  }

  const byLostClicks = (a: ContentDecaySignal, b: ContentDecaySignal): number =>
    b.baselineClicks - b.currentClicks - (a.baselineClicks - a.currentClicks) ||
    a.page.localeCompare(b.page)

  return {
    detections: detections.sort(byLostClicks),
    provisional: provisional.sort(byLostClicks),
    unknownPages,
  }
}

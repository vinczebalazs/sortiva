import { median } from '../ops'
import type { ClusterShareRow } from '../search'
import { type PageIndex, normalisePageUrl } from './types'

/**
 * The store measured against itself.
 *
 * Three of the four Search-Console signals ask whether a page is doing well or
 * badly *for this store* — never against an absolute number. Thirty clicks a
 * month is a triumph for a niche Danish store and a failure for a large one, so
 * the yardstick is the store's own middle page: half its pages do better, half
 * do worse. A page below that is not what we spend a merchant's attention on.
 *
 * "Rated" means the store was shown for the page at all in the window and we
 * hold the page in the inventory. Pages Google never showed contribute nothing
 * — including them would drag the middle towards zero and make almost every
 * page look above average.
 */

export interface PageTotals {
  readonly page: string
  readonly clicks: number
  readonly impressions: number
  /** Impression-weighted mean position across everything the page was shown for. Null when it was never shown. */
  readonly position: number | null
}

interface Accumulator {
  clicks: number
  impressions: number
  positionWeight: number
  positionWeightBase: number
}

/**
 * Totals per page over a window, from the same page-by-search rows the cluster
 * share table is built from — so a page's totals and its share of any one
 * intent can never disagree about the same window.
 */
export function pageTotals(rows: readonly ClusterShareRow[]): Map<string, PageTotals> {
  const acc = new Map<string, Accumulator>()
  for (const row of rows) {
    const page = normalisePageUrl(row.page)
    const into = acc.get(page) ?? {
      clicks: 0,
      impressions: 0,
      positionWeight: 0,
      positionWeightBase: 0,
    }
    into.clicks += row.clicks
    into.impressions += row.impressions
    if (row.position !== null && row.impressions) {
      into.positionWeight += row.position * row.impressions
      into.positionWeightBase += row.impressions
    }
    acc.set(page, into)
  }

  const out = new Map<string, PageTotals>()
  for (const [page, value] of acc) {
    out.set(page, {
      page,
      clicks: value.clicks,
      impressions: value.impressions,
      // Zero would read as "ranked first", which is the opposite of never shown.
      position: value.positionWeightBase ? value.positionWeight / value.positionWeightBase : null,
    })
  }
  return out
}

export interface StoreBaseline {
  readonly totals: ReadonlyMap<string, PageTotals>
  /** Null when the store has no rated pages at all, in which case nothing can be judged against it. */
  readonly medianImpressions: number | null
  readonly medianClicks: number | null
  /** Pages Search Console reported that the inventory does not hold. */
  readonly unknownPages: readonly string[]
}

/**
 * The store's own middle, plus the per-page totals every detector reads.
 *
 * Pages the inventory does not hold are left out of the middle *and* reported.
 * Counting a page we cannot act on towards the yardstick would move the bar for
 * every page we can, and dropping it silently is how a mismatch between the two
 * spellings of a URL turns into signals nobody notices going missing.
 */
export function storeBaseline(
  rows: readonly ClusterShareRow[],
  pages: PageIndex,
): StoreBaseline {
  const totals = pageTotals(rows)
  const rated: PageTotals[] = []
  const unknown: string[] = []

  for (const [page, value] of totals) {
    if (!pages.has(page)) {
      unknown.push(page)
      continue
    }
    if (!value.impressions) continue
    rated.push(value)
  }

  return {
    totals,
    medianImpressions: median(rated.map((row) => row.impressions)),
    medianClicks: median(rated.map((row) => row.clicks)),
    unknownPages: unknown.sort(),
  }
}

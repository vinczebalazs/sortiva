import type { GscSearchAnalyticsRow } from '../contracts/gsc'

/**
 * Turning Google's report into the two tables detection reads.
 *
 * Google is asked one question — clicks and impressions per page, per query, per
 * device and per country, per day — and answers with the finest-grained rows.
 * The page-level totals the performance chart uses are derived from those here
 * rather than bought in a second request: same numbers, one call.
 *
 * Position is the one field that cannot be summed. It is an average over
 * impressions, so a page's average position is each row's position weighted by
 * how many impressions it had. Averaging the averages instead would let a query
 * with three impressions pull the page's figure as hard as one with thirty
 * thousand.
 */

export interface QueryDailyRow {
  readonly date: string
  readonly page: string
  readonly query: string
  readonly device: string
  readonly country: string
  readonly clicks: number
  readonly impressions: number
  readonly position: number | null
}

export interface PageDailyRow {
  readonly date: string
  readonly page: string
  readonly clicks: number
  readonly impressions: number
  readonly position: number | null
}

/**
 * Average position is a mean over impressions, so combining two rows means
 * re-dividing the accumulated weight by the accumulated total. Written as its
 * own function because the "nothing was shown" case has a real answer — no
 * position was ever reported — and returning zero there would read as "ranked
 * first", which is the opposite of what happened.
 */
function weightedPosition(totalWeight: number, total: number): number | null {
  return total === 0 ? null : totalWeight / total
}

/**
 * Google can return two rows with the same four dimensions across paged
 * responses; the table keys on those four, so identical keys are merged here
 * rather than left to collide on insert.
 */
export function toQueryDailyRows(rows: readonly GscSearchAnalyticsRow[]): QueryDailyRow[] {
  const merged = new Map<string, { row: QueryDailyRow; positionWeight: number }>()
  for (const row of rows) {
    const key = [row.date, row.page, row.query, row.device, row.country].join(' ')
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, {
        row: {
          date: row.date,
          page: row.page,
          query: row.query,
          device: row.device,
          country: row.country,
          clicks: row.clicks,
          impressions: row.impressions,
          position: row.position,
        },
        positionWeight: row.position * row.impressions,
      })
      continue
    }
    const clicks = existing.row.clicks + row.clicks
    const impressions = existing.row.impressions + row.impressions
    const positionWeight = existing.positionWeight + row.position * row.impressions
    merged.set(key, {
      row: {
        ...existing.row,
        clicks,
        impressions,
        position: weightedPosition(positionWeight, impressions) ?? existing.row.position,
      },
      positionWeight,
    })
  }
  return [...merged.values()].map((entry) => entry.row)
}

/** Page-level totals for one day, rolled up from the same rows. */
export function toPageDailyRows(rows: readonly QueryDailyRow[]): PageDailyRow[] {
  const totals = new Map<
    string,
    { date: string; page: string; clicks: number; impressions: number; positionWeight: number }
  >()
  for (const row of rows) {
    const key = `${row.date} ${row.page}`
    const existing = totals.get(key) ?? {
      date: row.date,
      page: row.page,
      clicks: 0,
      impressions: 0,
      positionWeight: 0,
    }
    existing.clicks += row.clicks
    existing.impressions += row.impressions
    existing.positionWeight += (row.position ?? 0) * row.impressions
    totals.set(key, existing)
  }
  return [...totals.values()].map((entry) => ({
    date: entry.date,
    page: entry.page,
    clicks: entry.clicks,
    impressions: entry.impressions,
    position: weightedPosition(entry.positionWeight, entry.impressions),
  }))
}

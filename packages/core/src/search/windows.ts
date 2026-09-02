/**
 * Which days of search data to ask Google for, and in what order.
 *
 * Two jobs use this. The one-time import at connect walks backwards through
 * about sixteen months in fixed-size chunks, committing after each so a crash
 * costs one chunk rather than the lot. The daily sync re-asks for the most
 * recent days, because Google keeps revising them for about a week after the
 * fact and a single-day pull would freeze the first, lowest figure it reported.
 *
 * Every window stops short of today by the reporting lag, so a day Google has
 * not finished counting is never read as a day nobody searched.
 */

export interface DateRange {
  /** Inclusive, `YYYY-MM-DD`. */
  readonly startDate: string
  /** Inclusive, `YYYY-MM-DD`. */
  readonly endDate: string
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime())
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date.getTime())
  next.setUTCMonth(next.getUTCMonth() + months)
  return next
}

/** The most recent day Google is expected to have finished counting. */
export function latestReportableDate(today: Date, dataLagDays: number): Date {
  return addDays(startOfUtcDay(today), -dataLagDays)
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

export interface BackfillPlanInput {
  readonly today: Date
  readonly backfillMonths: number
  readonly chunkDays: number
  readonly dataLagDays: number
}

/**
 * The import's chunks, **newest first**. Order is the point: an import that is
 * still running when the merchant confirms their profile has already delivered
 * the recent months, which are the ones every signal weighs most heavily. The
 * older chunks improve year-on-year comparisons and can arrive late without
 * holding anything up.
 */
export function backfillRanges(input: BackfillPlanInput): DateRange[] {
  const { chunkDays } = input
  if (chunkDays < 1) throw new RangeError('backfill chunk size must be at least one day')

  const end = latestReportableDate(input.today, input.dataLagDays)
  const earliest = addMonths(end, -input.backfillMonths)

  const ranges: DateRange[] = []
  let chunkEnd = end
  while (chunkEnd >= earliest) {
    const candidateStart = addDays(chunkEnd, -(chunkDays - 1))
    const chunkStart = candidateStart < earliest ? earliest : candidateStart
    ranges.push({ startDate: toIsoDate(chunkStart), endDate: toIsoDate(chunkEnd) })
    chunkEnd = addDays(chunkStart, -1)
  }
  return ranges
}

/**
 * The daily pull's window: the last `lookbackDays` reportable days, so revisions
 * to days we already stored overwrite them instead of being missed.
 */
export function dailySyncRange(input: {
  today: Date
  lookbackDays: number
  dataLagDays: number
}): DateRange {
  if (input.lookbackDays < 1) throw new RangeError('the daily sync window must be at least one day')
  const end = latestReportableDate(input.today, input.dataLagDays)
  const start = addDays(end, -(input.lookbackDays - 1))
  return { startDate: toIsoDate(start), endDate: toIsoDate(end) }
}

/**
 * How far a part-finished import has got. Stored as the checkpoint after each
 * chunk, so a resumed run skips what is already in the database rather than
 * paying for it again.
 */
export interface BackfillCheckpoint {
  /** Ranges already committed, in the order they were done. */
  readonly completed: readonly string[]
  readonly rowsWritten: number
}

export function rangeKey(range: DateRange): string {
  return `${range.startDate}..${range.endDate}`
}

/** The next chunk to fetch, or undefined when the import is finished. */
export function nextRange(
  ranges: readonly DateRange[],
  checkpoint: BackfillCheckpoint | undefined,
): DateRange | undefined {
  const done = new Set(checkpoint?.completed ?? [])
  return ranges.find((range) => !done.has(rangeKey(range)))
}

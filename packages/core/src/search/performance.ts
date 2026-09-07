import { normalisePageUrl } from '../signals/types'
import { normaliseQuery } from './clusters'
import { toIsoDate, type DateRange } from './windows'

/**
 * What the two Performance screens are told, worked out from stored search
 * data and nothing else.
 *
 * Three rules shape every function here.
 *
 * **A day with no data is not a day with no traffic.** Search Console loses
 * days and our own sync can miss one; the series carries a null for such a day
 * so the chart breaks its line rather than drawing a collapse that never
 * happened.
 *
 * **A period is only ever compared with a period of the same length that has
 * also finished.** Google reports a couple of days late, so every window ends
 * at the last day we actually hold rather than at today — otherwise the current
 * period would carry two empty days against a full one behind it, and every
 * store in the product would look like it was declining.
 *
 * **Nothing here decides whether a page did well.** That verdict is the
 * learning loop's, is relative to the store's own median, and is never
 * pronounced before the measurement window is up. Until something computes one,
 * every row says it has no verdict rather than being given a flattering or a
 * damning one.
 */

// ── Windows ─────────────────────────────────────────────────────────────────

export type SearchConsoleWindowToken = '28d' | '3m' | '12m'

export interface ComparedWindows {
  /** The stretch the figures are for. */
  readonly current: DateRange
  /** The stretch immediately before it, of exactly the same length. */
  readonly prior: DateRange
}

function parseIsoDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`)
}

function shiftDays(date: Date, days: number): Date {
  const next = new Date(date.getTime())
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function shiftMonths(date: Date, months: number): Date {
  const next = new Date(date.getTime())
  next.setUTCMonth(next.getUTCMonth() + months)
  return next
}

/** How long a window token asks for, expressed as its own first day given its last. */
function firstDayOf(token: SearchConsoleWindowToken, lastDay: Date): Date {
  if (token === '28d') return shiftDays(lastDay, -27)
  if (token === '3m') return shiftDays(shiftMonths(lastDay, -3), 1)
  return shiftDays(shiftMonths(lastDay, -12), 1)
}

/**
 * The window a table covers and the equally long one behind it, both ending on
 * a day Google has finished counting.
 *
 * `lastDay` is the newest day the store has any data for rather than today,
 * which is what keeps the two halves comparable — see the note at the top of
 * this file.
 */
export function comparedWindows(lastDay: string, token: SearchConsoleWindowToken): ComparedWindows {
  const end = parseIsoDate(lastDay)
  const start = firstDayOf(token, end)
  const priorEnd = shiftDays(start, -1)
  const lengthDays = Math.round((end.getTime() - start.getTime()) / 86_400_000)
  const priorStart = shiftDays(priorEnd, -lengthDays)
  return {
    current: { startDate: toIsoDate(start), endDate: toIsoDate(end) },
    prior: { startDate: toIsoDate(priorStart), endDate: toIsoDate(priorEnd) },
  }
}

/** Every day from one date to another inclusive, as `YYYY-MM-DD`. */
export function daysBetween(startDate: string, endDate: string): string[] {
  const out: string[] = []
  const end = parseIsoDate(endDate)
  for (let day = parseIsoDate(startDate); day <= end; day = shiftDays(day, 1)) {
    out.push(toIsoDate(day))
  }
  return out
}

// ── The overview ────────────────────────────────────────────────────────────

export interface DayTotalInput {
  readonly date: string
  readonly clicks: number
  readonly impressions: number
}

export interface KeyTotalInput {
  readonly key: string
  readonly clicks: number
  readonly impressions: number
  readonly position: number | null
}

export interface PerformanceSeriesPoint {
  readonly date: string
  readonly clicks: number | null
  readonly impressions: number | null
}

export type PerformanceMarkerKind = 'gsc_connected' | 'article_published' | 'optimize_applied'

export interface PerformanceMarkerOut {
  readonly date: string
  readonly kind: PerformanceMarkerKind
  readonly label: string
}

export interface PerformanceResultOut {
  readonly kind: 'article' | 'page'
  readonly id: string
  readonly title: string
  readonly clicks: number
  readonly impressions: number
  readonly position: number
  readonly trend: 'up' | 'flat' | 'down'
  readonly label: string
  readonly publishedViaOverride: boolean
}

export interface PerformanceOverviewOut {
  readonly connected: boolean
  readonly series: readonly PerformanceSeriesPoint[]
  readonly markers: readonly PerformanceMarkerOut[]
  readonly results: readonly PerformanceResultOut[]
}

/**
 * The label a row carries when nothing has judged it.
 *
 * Not a verdict and not a placeholder for one: the screen renders it as "too
 * new to judge" and hides the figures behind it, which is the honest answer
 * while nothing computes a verdict at all.
 */
export const NO_VERDICT = 'unrated'

export interface PublishedArticleInput {
  readonly id: string
  readonly title: string
  /** Null for an export-mode article whose final address the merchant never confirmed. */
  readonly publishedUrl: string | null
  readonly publishedAt: string | null
  readonly publishedViaOverride: boolean
}

export interface AppliedOpportunityInput {
  readonly id: string
  readonly entityKind: 'query_cluster' | 'page' | 'product' | 'family' | 'article'
  readonly entityRef: string
  readonly recommendedAction: 'CREATE' | 'OPTIMIZE' | 'REFRESH' | 'FIX' | 'HOLD'
  readonly appliedAt: string
  /** Whatever the twenty-eight-day measurement recorded, if it has run. */
  readonly outcomeLabel: string | null
}

export interface StorePageInput {
  readonly url: string
  readonly title: string | null
  readonly pageType: string
}

export interface PerformanceOverviewInput {
  /** Null when the store never connected Search Console, or granted without picking a property. */
  readonly connection: { readonly property: string; readonly connectedAt: string } | null
  /** The newest day any search data exists for; null when none has arrived yet. */
  readonly latestDay: string | null
  readonly daily: readonly DayTotalInput[]
  /** Per-page totals over the measurement window and the one before it. */
  readonly pagesCurrent: readonly KeyTotalInput[]
  readonly pagesPrior: readonly KeyTotalInput[]
  readonly articles: readonly PublishedArticleInput[]
  readonly applied: readonly AppliedOpportunityInput[]
  readonly storePages: readonly StorePageInput[]
}

export function buildPerformanceOverview(input: PerformanceOverviewInput): PerformanceOverviewOut {
  if (!input.connection) {
    return { connected: false, series: [], markers: [], results: [] }
  }

  const series = buildSeries(input)
  const drawnDays = new Set(series.map((point) => point.date))
  const current = indexTotals(input.pagesCurrent)
  const prior = indexTotals(input.pagesPrior)
  const titles = new Map(
    input.storePages.map((page) => [normalisePageUrl(page.url), page.title ?? page.url]),
  )

  return {
    connected: true,
    series,
    markers: buildMarkers(input, drawnDays),
    results: [...articleResults(input, current, prior), ...pageResults(input, current, prior, titles)],
  }
}

/**
 * One point per day from the day Search Console was connected to the last day
 * we hold data for.
 *
 * It stops at the last day we hold rather than at today so the two most recent
 * days — which Google has not finished counting — are not drawn as an absence
 * every merchant would read as a cliff. Days missing inside the range stay
 * missing, and the screen says how many there were.
 */
function buildSeries(input: PerformanceOverviewInput): PerformanceSeriesPoint[] {
  const connection = input.connection
  if (!connection || !input.latestDay) return []
  if (input.latestDay < connection.connectedAt) return []

  const totals = new Map(input.daily.map((day) => [day.date, day]))
  return daysBetween(connection.connectedAt, input.latestDay).map((date) => {
    const total = totals.get(date)
    return {
      date,
      clicks: total ? total.clicks : null,
      impressions: total ? total.impressions : null,
    }
  })
}

/**
 * The three things we can put a date against: the day the merchant connected,
 * the day each article went out, and the day each page improvement was marked
 * applied.
 *
 * Markers for days outside the drawn range are dropped here rather than left
 * for the chart to discard, so what the screen is sent is what it can draw.
 */
function buildMarkers(
  input: PerformanceOverviewInput,
  drawnDays: ReadonlySet<string>,
): PerformanceMarkerOut[] {
  const connection = input.connection
  if (!connection) return []

  const markers: PerformanceMarkerOut[] = [
    { date: connection.connectedAt, kind: 'gsc_connected', label: connection.property },
  ]

  for (const article of input.articles) {
    if (article.publishedAt) {
      markers.push({
        date: article.publishedAt.slice(0, 10),
        kind: 'article_published',
        label: article.title,
      })
    }
  }

  for (const opportunity of input.applied) {
    if (opportunity.recommendedAction !== 'OPTIMIZE') continue
    markers.push({
      date: opportunity.appliedAt.slice(0, 10),
      kind: 'optimize_applied',
      label: opportunity.entityRef,
    })
  }

  return markers.filter((marker) => drawnDays.has(marker.date))
}

function indexTotals(totals: readonly KeyTotalInput[]): Map<string, KeyTotalInput> {
  return new Map(totals.map((total) => [normalisePageUrl(total.key), total]))
}

/**
 * Every article with an address we can attribute search data to.
 *
 * An export-mode article whose final address the merchant never confirmed is
 * left out: we have no way to tell its rows from anybody else's, and listing it
 * with noughts would read as an article nobody found rather than as one we
 * cannot see.
 */
function articleResults(
  input: PerformanceOverviewInput,
  current: ReadonlyMap<string, KeyTotalInput>,
  prior: ReadonlyMap<string, KeyTotalInput>,
): PerformanceResultOut[] {
  const out: PerformanceResultOut[] = []
  for (const article of input.articles) {
    if (!article.publishedUrl) continue
    const key = normalisePageUrl(article.publishedUrl)
    out.push({
      kind: 'article',
      id: article.id,
      title: article.title,
      ...figuresFor(current.get(key), prior.get(key)),
      label: NO_VERDICT,
      publishedViaOverride: article.publishedViaOverride,
    })
  }
  return out
}

/** Every store page whose improvement the merchant said they carried out. */
function pageResults(
  input: PerformanceOverviewInput,
  current: ReadonlyMap<string, KeyTotalInput>,
  prior: ReadonlyMap<string, KeyTotalInput>,
  titles: ReadonlyMap<string, string>,
): PerformanceResultOut[] {
  const out: PerformanceResultOut[] = []
  for (const opportunity of input.applied) {
    if (opportunity.entityKind !== 'page') continue
    const key = normalisePageUrl(opportunity.entityRef)
    out.push({
      kind: 'page',
      id: opportunity.id,
      title: titles.get(key) ?? opportunity.entityRef,
      ...figuresFor(current.get(key), prior.get(key)),
      label: opportunity.outcomeLabel ?? NO_VERDICT,
      publishedViaOverride: false,
    })
  }
  return out
}

function figuresFor(
  current: KeyTotalInput | undefined,
  prior: KeyTotalInput | undefined,
): { clicks: number; impressions: number; position: number; trend: 'up' | 'flat' | 'down' } {
  const now = current ?? { key: '', clicks: 0, impressions: 0, position: null }
  const before = prior?.clicks ?? 0
  return {
    clicks: now.clicks,
    impressions: now.impressions,
    position: now.position ?? 0,
    trend: direction(now.clicks, before),
  }
}

function direction(now: number, before: number): 'up' | 'flat' | 'down' {
  if (now > before) return 'up'
  if (now < before) return 'down'
  return 'flat'
}

// ── The Search Console tables ───────────────────────────────────────────────

export type ContractPageType = 'collection' | 'product' | 'page' | 'blog' | 'our_article'

const PAGE_TYPES: Readonly<Record<string, ContractPageType>> = {
  collection: 'collection',
  product: 'product',
  page: 'page',
  blog_article: 'blog',
  article_ours: 'our_article',
}

export interface RowSignalOut {
  readonly signalType: string
  readonly opportunityId: string
}

export interface SearchConsoleRowOut {
  readonly key: string
  readonly clicks: number
  readonly impressions: number
  readonly ctr: number
  readonly position: number
  readonly deltaClicks: number
  readonly deltaPosition: number
  readonly pageType: ContractPageType | null
  readonly signals: readonly RowSignalOut[]
}

export interface OpenOpportunityInput {
  readonly id: string
  readonly signalType: string
  readonly entityKind: 'query_cluster' | 'page' | 'product' | 'family' | 'article'
  readonly entityRef: string
}

export interface SearchConsoleTableInput {
  readonly dimension: 'query' | 'page'
  readonly current: readonly KeyTotalInput[]
  readonly prior: readonly KeyTotalInput[]
  readonly storePages: readonly StorePageInput[]
  readonly open: readonly OpenOpportunityInput[]
}

/**
 * One table's rows: what each search or page did, how that changed, and the way
 * into the opportunity about it.
 *
 * The badges are what make this a table worth having — every one is a link to a
 * scored opportunity with an action attached, rather than a figure to admire. A
 * row is matched to an opportunity by the very string the opportunity is keyed
 * on, so a badge can never point at work about something else.
 */
export function buildSearchConsoleRows(input: SearchConsoleTableInput): SearchConsoleRowOut[] {
  const byPage = input.dimension === 'page'
  const identity = (value: string) => (byPage ? normalisePageUrl(value) : normaliseQuery(value))
  const prior = new Map(input.prior.map((total) => [identity(total.key), total]))

  const pageTypes = new Map(
    input.storePages.map((page) => [normalisePageUrl(page.url), PAGE_TYPES[page.pageType] ?? null]),
  )

  const signals = new Map<string, RowSignalOut[]>()
  for (const opportunity of input.open) {
    const matches = byPage
      ? opportunity.entityKind === 'page'
      : opportunity.entityKind === 'query_cluster'
    if (!matches) continue
    const id = identity(opportunity.entityRef)
    const existing = signals.get(id)
    const badge = { signalType: opportunity.signalType, opportunityId: opportunity.id }
    if (existing) existing.push(badge)
    else signals.set(id, [badge])
  }

  return input.current.map((total) => {
    const id = identity(total.key)
    const before = prior.get(id)
    const position = total.position ?? 0
    return {
      key: total.key,
      clicks: total.clicks,
      impressions: total.impressions,
      ctr: ratio(total.clicks, total.impressions),
      position,
      deltaClicks: total.clicks - (before?.clicks ?? 0),
      // Nothing to compare against is not a change: a page that was invisible
      // last period has no earlier place in the results to have moved from, and
      // calling that a fall from position nought would be nonsense.
      deltaPosition: before?.position == null ? 0 : position - before.position,
      pageType: byPage ? (pageTypes.get(id) ?? null) : null,
      signals: signals.get(id) ?? [],
    }
  })
}

/** A plain division that answers nought rather than infinity when there is nothing to divide by. */
function ratio(numerator: number, denominator: number): number {
  const divisor = denominator
  return divisor === 0 ? 0 : numerator / divisor
}

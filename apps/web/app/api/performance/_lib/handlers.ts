import {
  buildPerformanceOverview,
  buildSearchConsoleRows,
  comparedWindows,
  performanceOverviewResponseSchema,
  searchConsoleQuerySchema,
  searchConsoleResponseSchema,
  searchConsoleConnectionState,
  toContractOpportunity,
  toIsoDate,
  type AppliedOpportunityInput,
  type KeyTotalInput,
  type OpenOpportunityInput,
  type PublishedArticleInput,
  type SearchConsoleRowOut,
  type SearchConsoleWindowToken,
  type StorePageInput,
} from '@sortiva/core'
import type { OpportunityRow, PerformanceStore, StorePageRow } from '@sortiva/db'
import { rules } from '@sortiva/rules'
import type { AccountHandler } from '../../auth/_lib/session'

/**
 * `/api/performance/*` — the two screens that answer "did any of this work?".
 *
 * Everything they show is read back from stored Search Console data. Nothing
 * here calls Google: the daily sync writes the rows and these routes only ever
 * add them up, so a slow or dead Google cannot stall a page load.
 *
 * A store that never connected Search Console is not an error. The overview
 * answers that it is not connected and the screen shows the connect card in
 * place of the chart; the tables answer with no rows. Both are honest, and both
 * are what the merchant can act on.
 *
 * A store whose Search Console grant later *died* is a different case and is
 * deliberately still treated as connected: the history we already synced is
 * real and still worth showing, and the reconnect prompt lives in Settings.
 */

export interface PerformanceDeps {
  readonly store: PerformanceStore
}

/**
 * How many rows one answer of the Search Console tables carries.
 *
 * Not a threshold anything is judged against — it bounds a response, nothing
 * more. A twelve-month window on a large catalogue groups to tens of thousands
 * of searches, and sending all of them would make the page that is meant to be
 * a way into Opportunities the slowest screen in the product. Rows come back
 * busiest first, so what a page holds is what a merchant would look at, and the
 * cursor means nothing is unreachable through the API.
 */
const ROWS_PER_PAGE = 250

/** The label the twenty-eight-day measurement recorded, if it has ever run. */
function outcomeLabelOf(row: OpportunityRow): string | null {
  const outcome = row.outcomeJson as { label?: unknown } | null
  return outcome && typeof outcome.label === 'string' ? outcome.label : null
}

function toStorePageInputs(rows: readonly StorePageRow[]): StorePageInput[] {
  return rows.map((row) => ({ url: row.url, title: row.title, pageType: row.pageType }))
}

function toAppliedInputs(rows: readonly OpportunityRow[]): AppliedOpportunityInput[] {
  const confidence = rules().defaults.scoring.confidence
  const out: AppliedOpportunityInput[] = []
  for (const row of rows) {
    if (!row.appliedAt) continue
    const opportunity = toContractOpportunity(row, confidence)
    out.push({
      id: row.id,
      entityKind: opportunity.entityRef.kind,
      entityRef: opportunity.entityRef.id,
      recommendedAction: opportunity.recommendedAction,
      appliedAt: row.appliedAt.toISOString(),
      outcomeLabel: outcomeLabelOf(row),
    })
  }
  return out
}

function toOpenInputs(rows: readonly OpportunityRow[]): OpenOpportunityInput[] {
  const confidence = rules().defaults.scoring.confidence
  return rows.map((row) => {
    const opportunity = toContractOpportunity(row, confidence)
    return {
      id: row.id,
      signalType: opportunity.signalType,
      entityKind: opportunity.entityRef.kind,
      entityRef: opportunity.entityRef.id,
    }
  })
}

const NOT_CONNECTED = { connected: false, series: [], markers: [], results: [] }

/**
 * `GET /api/performance/overview` — the chart, what we did and when, and what
 * became of each thing we published or improved.
 */
export function makePerformanceOverviewHandler(deps: PerformanceDeps): AccountHandler {
  return async (_request, { scope }) => {
    const connection = await deps.store.connection(scope)
    if (searchConsoleConnectionState(connection ?? null) === 'none' || !connection) {
      return Response.json(performanceOverviewResponseSchema.parse(NOT_CONNECTED))
    }

    const connectedAt = toIsoDate(connection.connectedAt)
    const latestDay = await deps.store.latestDay(scope)

    // The results table is the trailing twenty-eight days against the
    // twenty-eight before, both ending on the last day Google has finished
    // counting rather than on today.
    const windows = latestDay ? comparedWindows(latestDay, '28d') : null

    const [daily, pagesCurrent, pagesPrior, articles, storePages, applied] = await Promise.all([
      latestDay ? deps.store.daily(scope, { startDate: connectedAt, endDate: latestDay }) : [],
      windows ? deps.store.pages(scope, windows.current) : [],
      windows ? deps.store.pages(scope, windows.prior) : [],
      deps.store.articles(scope),
      deps.store.storePages(scope),
      deps.store.appliedOpportunities(scope),
    ])

    const published: PublishedArticleInput[] = articles
      .filter((article) => article.state === 'published')
      .map((article) => ({
        id: article.id,
        title: article.title,
        publishedUrl: article.publishedUrl,
        publishedAt: article.publishedAt ? article.publishedAt.toISOString() : null,
        publishedViaOverride: article.publishedViaOverride,
      }))

    const body = buildPerformanceOverview({
      connection: { property: connection.property, connectedAt },
      latestDay,
      daily,
      pagesCurrent,
      pagesPrior,
      articles: published,
      applied: toAppliedInputs(applied),
      storePages: toStorePageInputs(storePages),
    })

    return Response.json(performanceOverviewResponseSchema.parse(body))
  }
}

const EMPTY_TABLE = { rows: [], cursor: null }

/**
 * `GET /api/performance/search-console` — one table of searches or pages, each
 * row carrying the opportunity about it where one is open.
 */
export function makeSearchConsoleHandler(deps: PerformanceDeps): AccountHandler {
  return async (request, { scope }) => {
    const params = new URL(request.url).searchParams
    const parsed = searchConsoleQuerySchema.safeParse({
      dimension: params.get('dimension') ?? undefined,
      window: params.get('window') ?? undefined,
      ...(params.get('cursor') ? { cursor: params.get('cursor') as string } : {}),
    })
    if (!parsed.success) {
      return Response.json(
        { error: { code: 'invalid_query', message: 'Ask for dimension=query|page and window=28d|3m|12m.' } },
        { status: 422 },
      )
    }
    const { dimension, window: token } = parsed.data

    const connection = await deps.store.connection(scope)
    if (searchConsoleConnectionState(connection ?? null) === 'none') {
      return Response.json(searchConsoleResponseSchema.parse(EMPTY_TABLE))
    }

    const latestDay = await deps.store.latestDay(scope)
    if (!latestDay) return Response.json(searchConsoleResponseSchema.parse(EMPTY_TABLE))

    const windows = comparedWindows(latestDay, token as SearchConsoleWindowToken)
    const read = (range: { startDate: string; endDate: string }): Promise<KeyTotalInput[]> =>
      dimension === 'page' ? deps.store.pages(scope, range) : deps.store.queries(scope, range)

    const [current, prior, storePages, open] = await Promise.all([
      read(windows.current),
      read(windows.prior),
      deps.store.storePages(scope),
      deps.store.openOpportunities(scope),
    ])

    const rows = buildSearchConsoleRows({
      dimension,
      current,
      prior,
      storePages: toStorePageInputs(storePages),
      open: toOpenInputs(open),
    })

    return Response.json(
      searchConsoleResponseSchema.parse(page(rows, `${dimension}:${token}`, parsed.data.cursor)),
    )
  }
}

/**
 * One page of rows and the way to ask for the next.
 *
 * The cursor names the table it came from as well as the place in it, so a
 * cursor kept across a change of dimension or window is refused rather than
 * quietly applied to a different set of rows.
 */
function page(
  rows: readonly SearchConsoleRowOut[],
  table: string,
  cursor: string | undefined,
): { rows: readonly SearchConsoleRowOut[]; cursor: string | null } {
  const start = offsetOf(cursor, table)
  const slice = rows.slice(start, start + ROWS_PER_PAGE)
  const next = start + ROWS_PER_PAGE
  return { rows: slice, cursor: next < rows.length ? `${table}:${next}` : null }
}

function offsetOf(cursor: string | undefined, table: string): number {
  if (!cursor || !cursor.startsWith(`${table}:`)) return 0
  const offset = Number.parseInt(cursor.slice(table.length + 1), 10)
  return Number.isSafeInteger(offset) && offset > 0 ? offset : 0
}

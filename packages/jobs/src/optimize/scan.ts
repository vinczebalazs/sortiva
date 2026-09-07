import {
  buildIntentGapSignal,
  excerptOf,
  indexPages,
  shortlistIntentGapPages,
  type ClusterDefinition,
  type ClusterShareRow,
  type ExistingPageIntentGapSignal,
  type IntentGapCandidate,
  type PageFact,
} from '@sortiva/core'
import { accountScope, listLiveStorePages, readStorePageBody, type Db } from '@sortiva/db'
import { rules } from '@sortiva/rules'
import { analyseIntentGap, type AnalyseIntentGapDeps } from './analyse'
import { runtimeLogger } from '../runtime/logging'

/**
 * The weekly pass: which of a store's pages answer less than the pages above
 * them.
 *
 * Deliberately not every page. The free filter picks the ones already sitting
 * where editing could move them, and a ceiling below the store's own daily
 * allowance of paid comparisons caps how many of those get compared in one
 * pass, so a large store's scan leaves room for the comparisons the merchant
 * buys themselves by pressing "improve this page".
 *
 * This returns signals rather than writing opportunities. Reconciling a
 * detection onto the `opportunities` table — the upsert on the partial unique
 * index, the task rows, the status guards — is the signal scan's own job and
 * happens in one place for every detector; a second writer would be a second
 * chance to get the dedupe wrong.
 */

export interface ScanIntentGapsDeps extends AnalyseIntentGapDeps {
  readonly db: Db
}

export interface ScanIntentGapsInput {
  readonly accountId: string
  /** Query clusters as the scan already assembled them. */
  readonly clusters: readonly ClusterDefinition[]
  /** Page-by-search totals over the scan window. */
  readonly rows: readonly ClusterShareRow[]
  readonly locale: { readonly language: string; readonly country: string }
  /** Pages the competitor-coverage detector picked out as our existing target for a keyword competitors rank for. */
  readonly competitorGapTargets?: readonly {
    readonly page: string
    readonly clusterHead: string
    readonly position: number
    readonly clusterImpressions: number
  }[]
  readonly allowSerpSpend?: boolean
}

export interface ScanIntentGapsResult {
  readonly signals: readonly ExistingPageIntentGapSignal[]
  readonly shortlisted: number
  readonly analysed: number
  /** True when the store's allowance for this call type ran out part-way, so the rest of the shortlist was left alone. */
  readonly pausedPartWay: boolean
  /** Pages we could not compare, and why — a page nobody could reach is not the same as a page with nothing missing. */
  readonly skipped: readonly { readonly page: string; readonly reason: string }[]
}

export async function scanIntentGaps(
  deps: ScanIntentGapsDeps,
  input: ScanIntentGapsInput,
): Promise<ScanIntentGapsResult> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const config = rules().defaults.signals.existing_page_intent_gap

  // Only the pages the store still serves. A page the merchant has deleted
  // cannot be improved, and comparing it against the pages ranking above it
  // spends a search purchase and a model call on advice nobody can apply.
  const inventory = await listLiveStorePages(deps.db, accountScope(input.accountId))
  const pageFacts: PageFact[] = inventory.map((row) => ({
    url: row.url,
    pageType: row.pageType,
    intentClass: row.intentClass,
  }))

  const shortlist = shortlistIntentGapPages({
    clusters: input.clusters,
    rows: input.rows,
    pages: indexPages(pageFacts),
    config,
    ...(input.competitorGapTargets ? { competitorGapTargets: input.competitorGapTargets } : {}),
    // Deliberately fewer pages than the store's whole daily allowance of paid
    // comparisons. The merchant's own "improve this page" button buys one more
    // each time it is pressed and does not know this pass ran, so a pass that
    // used the full allowance would leave the button spending past the store's
    // own brake — on an ordinary day, with nobody doing anything unusual.
    limit: rules().defaults.budgets.intent_gap.scheduled_shortlist_max,
  })

  const byUrl = new Map(inventory.map((row) => [row.url, row]))
  const signals: ExistingPageIntentGapSignal[] = []
  const skipped: { page: string; reason: string }[] = []
  let analysed = 0
  let pausedPartWay = false

  for (const candidate of shortlist) {
    const row = byUrl.get(candidate.page)
    if (!row || row.checksum === null) {
      skipped.push({ page: candidate.page, reason: 'page_not_in_inventory' })
      continue
    }

    const outcome = await analyseIntentGap(deps, {
      accountId: input.accountId,
      page: {
        url: row.url,
        title: row.title,
        headings: (row.headingsJson as string[] | null) ?? [],
        excerpt: excerptOf(stripToText(readStorePageBody(row))),
        checksum: row.checksum,
      },
      query: candidate.clusterHead,
      locale: input.locale,
      ...(input.allowSerpSpend === undefined ? {} : { allowSerpSpend: input.allowSerpSpend }),
    })

    if (outcome.status === 'paused') {
      // Not an error and not a partial result to paper over: the rest of the
      // shortlist is left for tomorrow, and the caller is told it happened.
      pausedPartWay = true
      skipped.push({ page: candidate.page, reason: `paused:${outcome.reason}` })
      break
    }
    if (outcome.status === 'unavailable') {
      skipped.push({ page: candidate.page, reason: outcome.reason })
      continue
    }

    analysed += 1
    const signal = buildIntentGapSignal({
      candidate: candidate satisfies IntentGapCandidate,
      analysis: outcome.analysis,
      config,
      analysedAt: now.toISOString(),
    })
    if (signal) signals.push(signal)
  }

  log.info('intent_gap.scan_completed', {
    account_id: input.accountId,
    shortlisted: shortlist.length,
    analysed,
    detected: signals.length,
    paused_part_way: pausedPartWay,
  })

  return { signals, shortlisted: shortlist.length, analysed, pausedPartWay, skipped }
}

const TAG = /<[^>]*>/g
const WHITESPACE = /\s+/g

/** The stored page body is markup; the comparison reads prose. */
function stripToText(bodyHtml: string | null): string {
  if (!bodyHtml) return ''
  return bodyHtml.replace(TAG, ' ').replace(WHITESPACE, ' ').trim()
}

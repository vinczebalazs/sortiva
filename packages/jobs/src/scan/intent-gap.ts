import {
  buildIntentGapSignal,
  groundSubtopics,
  serpSnapshotKey,
  shortlistIntentGapPages,
  type ClusterDefinition,
  type ClusterShareRow,
  type CoverageAnalysisOutput,
  type CoverageCompetitorPage,
  type ExistingPageIntentGapSignal,
  type Logger,
  type PageIndex,
} from '@sortiva/core'
import {
  accountScope,
  findFreshSerpSnapshot,
  listLiveStorePages,
  readCachedRequest,
  resultsOf,
  systemScope,
  type Db,
} from '@sortiva/db'
import { rules } from '@sortiva/rules'
import { intentGapCacheKey } from '../optimize/analyse'
import { runtimeLogger } from '../runtime/logging'

/**
 * The free half of intent-gap detection: read the comparison somebody else
 * already paid for.
 *
 * Working out which of a store's pages answer less than the pages above them
 * costs a bought results page, five page reads and a model call. That happens
 * in its own scheduled pass, on the day before this scan runs. Everything here
 * is arithmetic over rows we already hold, which is what lets the weekly scan
 * carry this signal at all: a slow page fetch or a model outage delays that
 * pass and cannot delay, or fail, any other signal in this one.
 *
 * The join between the two halves is a cache key nobody stores — it is
 * recomputed from three things both sides can see: the page's own change
 * fingerprint, the identity of the search whose results page was read, and the
 * moment that results page was read. A page the merchant edited, or a results
 * page bought again since, therefore produces a key nothing was written under,
 * and this reader skips it rather than replaying a comparison of an older
 * version of either. That is the intended behaviour, not a miss to work around:
 * the next pass buys the comparison again under the new key.
 */

export interface IntentGapReadDeps {
  readonly db: Db
  readonly now?: () => Date
  readonly logger?: Logger
}

export interface IntentGapReadInput {
  readonly accountId: string
  /** Query clusters as this scan just rebuilt them. */
  readonly clusters: readonly ClusterDefinition[]
  /** Page-by-search totals over the scan window. */
  readonly rows: readonly ClusterShareRow[]
  readonly pages: PageIndex
  /** The store's own market — half of the search identity the results page was bought under. */
  readonly locale: { readonly language: string; readonly country: string }
}

export interface IntentGapReadResult {
  readonly signals: readonly ExistingPageIntentGapSignal[]
  readonly shortlisted: number
  /**
   * Pages a stored comparison was actually found and read for, whether or not
   * it turned out to hold a gap. The scan expires an open intent-gap row only
   * for a page in this set: a comparison we could not find means we did not
   * look, which is not the same as evidence that no longer holds.
   */
  readonly reEvaluated: ReadonlySet<string>
  /**
   * Every page Search Console still places inside the band this signal is
   * defined over — between the two positions in `packages/rules` — for at
   * least one of the store's intents.
   *
   * Uncapped, unlike `shortlisted`. The shortlist is cut to the store's daily
   * allowance of paid comparisons, so a page can fall off it purely because
   * the store had more candidates than budget that day; that says nothing
   * about the page. This set is the band itself, which is the thing an open
   * opportunity's premise rests on.
   */
  readonly inBand: ReadonlySet<string>
  /** Every address the store still serves, so absence here means "deleted", not "moved out of the band". */
  readonly livePages: ReadonlySet<string>
  /** Pages the scan passed over, and why — a page nobody compared is not a page with nothing missing. */
  readonly skipped: readonly { readonly page: string; readonly reason: string }[]
}

export async function readIntentGapSignals(
  deps: IntentGapReadDeps,
  input: IntentGapReadInput,
): Promise<IntentGapReadResult> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const system = systemScope('results pages are shared across stores; they carry no account')

  // Read from the defaults rather than the store's locale layer, because the
  // pass that wrote these comparisons reads the defaults. The two halves have
  // to agree on the search depth and the shortlist band or this side computes a
  // key the other side never wrote under, and the signal silently stops
  // appearing for stores in that locale.
  const config = rules().defaults.signals.existing_page_intent_gap
  const limit = rules().defaults.budgets.intent_gap.analyses_per_account_per_day

  const inventory = await listLiveStorePages(deps.db, accountScope(input.accountId))
  const byUrl = new Map(inventory.map((row) => [row.url, row]))

  // Asked for uncapped and cut afterwards, rather than asked for twice. The
  // shortlist function's own last act is this same slice, so the two are the
  // same set by construction — and the uncut list is the band membership the
  // scan's expiry needs, which a capped list cannot answer for.
  const inBand = shortlistIntentGapPages({
    clusters: input.clusters,
    rows: input.rows,
    pages: input.pages,
    config,
    limit: Number.MAX_SAFE_INTEGER,
  })
  const shortlist = inBand.slice(0, limit)

  const signals: ExistingPageIntentGapSignal[] = []
  const skipped: { page: string; reason: string }[] = []
  const reEvaluated = new Set<string>()

  for (const candidate of shortlist) {
    const row = byUrl.get(candidate.page)
    if (!row || row.checksum === null) {
      skipped.push({ page: candidate.page, reason: 'page_not_in_inventory' })
      continue
    }

    const serpKey = serpSnapshotKey({
      query: candidate.clusterHead,
      locale: input.locale,
      depth: config.serp_top_n,
    })
    const snapshot = await findFreshSerpSnapshot(deps.db, system, serpKey, now)
    if (!snapshot) {
      skipped.push({ page: candidate.page, reason: 'no_fresh_serp' })
      continue
    }

    const held = await readCachedRequest(
      deps.db,
      system,
      intentGapCacheKey({
        pageChecksum: row.checksum,
        serpCacheKey: snapshot.cacheKey,
        serpFetchedAt: snapshot.fetchedAt,
      }),
    )
    if (!held) {
      skipped.push({ page: candidate.page, reason: 'no_cached_analysis' })
      continue
    }

    // The same shape the paying side derives its answer from: our own page is
    // not one of the pages we are compared against, and the consensus floor is
    // read against however many ranking pages the comparison actually saw.
    const results = resultsOf(snapshot)
      .filter((result) => result.url !== row.url)
      .slice(0, config.serp_top_n)

    reEvaluated.add(candidate.page)

    const signal = buildIntentGapSignal({
      candidate,
      analysis: {
        // Worked out here rather than stored, so the consensus floor in
        // `packages/rules` can change without the comparison being bought again.
        subtopics: groundSubtopics(held.responseJson as CoverageAnalysisOutput, competitorShells(results)),
        topPagesAnalysed: results.length,
        // Nothing downstream of the signal reads these three; they describe a
        // model call this side never made.
        modelId: 'replayed',
        promptVersion: 'replayed',
        cacheHit: true,
        usdCost: 0,
      },
      config,
      // When the comparison was made, not when it was read back. The evidence a
      // merchant sees should date from the reading it rests on.
      analysedAt: held.createdAt.toISOString(),
    })
    if (signal) signals.push(signal)
  }

  log.info('intent_gap.read_completed', {
    account_id: input.accountId,
    shortlisted: shortlist.length,
    in_band: inBand.length,
    replayed: reEvaluated.size,
    detected: signals.length,
    skipped: skipped.length,
  })

  return {
    signals,
    shortlisted: shortlist.length,
    reEvaluated,
    inBand: new Set(inBand.map((candidate) => candidate.page)),
    livePages: new Set(inventory.map((row) => row.url)),
    skipped,
  }
}

/**
 * A replay knows which addresses were on the results page but never fetched
 * what is on them — it does not need to, the comparison is already made. These
 * stand in so the same grounding filter runs here as ran when the answer was
 * bought: a citation to a page that was not on the results page is dropped.
 */
function competitorShells(
  results: readonly { url: string; domain: string; position: number; title: string | null }[],
): CoverageCompetitorPage[] {
  return results.map((result) => ({
    url: result.url,
    domain: result.domain,
    position: result.position,
    title: result.title,
    headings: [],
    excerpt: '',
  }))
}

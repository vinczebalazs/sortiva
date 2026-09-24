import {
  analyseCoverage,
  buildCompetitorAngle,
  groundSubtopics,
  serpLocaleTag,
  serpSnapshotKey,
  type CoverageAnalysis,
  type CoverageAnalysisInput,
  type CoverageAnalysisOutput,
  type CoverageCompetitorPage,
  type CoveragePage,
  type CoveragePrompt,
  type LlmClient,
  type Logger,
  type SeoDataProvider,
} from '@sortiva/core'
import {
  findFreshSerpSnapshot,
  putBeforeProcessing,
  readCachedRequest,
  resultsOf,
  systemScope,
  upsertSerpSnapshot,
  type Db,
} from '@sortiva/db'
import { rules } from '@sortiva/rules'
import type { PageFetcher } from '@sortiva/providers'
import { mayCallTypeRun } from '../runtime/gate'
import { runtimeLogger } from '../runtime/logging'

/**
 * The paid half of intent-gap detection: buy a results page if we do not hold a
 * fresh one, read the pages on it, and ask the model what they settle that our
 * page does not.
 *
 * Three things guard the spend, in this order.
 *
 * **The store's daily allowance.** Crossing it raises `account.pause_intent_gap`
 * (the nightly auto-trip sweep counts the calls and raises the flag); this
 * function refuses while it is up, and nothing else stops — the store's daily
 * article is written as usual, because pausing one paid call type is not
 * pausing the product.
 *
 * **A comparison we have already made.** The answer is cached on the page's own
 * change detector and the identity of the results page it was made against, so
 * a page nobody edited, compared against a results page nobody re-bought, costs
 * nothing to ask about again — no vendor call, no page fetches, no model call.
 *
 * **Never on a stale results page.** If we hold no fresh snapshot and cannot buy
 * one, the analysis does not happen. Main §14.4's rule is that we pause rather
 * than decide on old data, and a coverage comparison against last month's
 * results is exactly that decision.
 */

/** Our page as this analysis needs it: what it says, and the fingerprint that says whether it has changed. */
export interface IntentGapPage extends CoveragePage {
  /** `store_pages.checksum` — moves when the merchant edits the page, stays put when nothing did. */
  readonly checksum: string
}

export interface AnalyseIntentGapDeps {
  readonly db: Db
  readonly seo: SeoDataProvider
  readonly pageFetcher: PageFetcher
  readonly llm: LlmClient
  readonly prompt: CoveragePrompt
  readonly now?: () => Date
  readonly logger?: Logger
}

export interface AnalyseIntentGapInput {
  readonly accountId: string
  readonly page: IntentGapPage
  /** The search the comparison is about — the query cluster's head. */
  readonly query: string
  readonly locale: { readonly language: string; readonly country: string }
  /**
   * Whether this run may buy a results page it does not already hold. False on
   * a sweep that is only allowed to work from what is cached.
   */
  readonly allowSerpSpend?: boolean
}

export type AnalyseIntentGapOutcome =
  | { readonly status: 'analysed'; readonly analysis: CoverageAnalysis }
  /** The store's daily allowance for this call type is spent, or work is paused. Nothing was bought. */
  | { readonly status: 'paused'; readonly flag?: string; readonly reason: string }
  /** We could not assemble something worth comparing against. Nothing was bought beyond what is named. */
  | { readonly status: 'unavailable'; readonly reason: 'no_fresh_serp' | 'no_reachable_pages' }

const CACHE_PREFIX = 'intent-gap.v1'

/** Keyed on what the answer actually depends on: this version of the page, compared against this reading of the results. */
export function intentGapCacheKey(input: {
  readonly pageChecksum: string
  readonly serpCacheKey: string
  readonly serpFetchedAt: Date
}): string {
  return `${CACHE_PREFIX}:${input.pageChecksum}:${input.serpCacheKey}:${input.serpFetchedAt.toISOString()}`
}

export async function analyseIntentGap(
  deps: AnalyseIntentGapDeps,
  input: AnalyseIntentGapInput,
): Promise<AnalyseIntentGapOutcome> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const system = systemScope('results pages are shared across stores; they carry no account')
  const config = rules().defaults.signals.existing_page_intent_gap
  const ttlMs = rules().defaults.discovery.cache.serp_snapshot_ttl_days * 24 * 60 * 60 * 1000

  const gate = await mayCallTypeRun(deps.db, input.accountId, 'intent_gap', log)
  if (!gate.allowed) {
    log.info('intent_gap.paused', {
      account_id: input.accountId,
      page: input.page.url,
      reason: gate.reason,
    })
    return {
      status: 'paused',
      reason: gate.reason,
      ...(gate.reason === 'paused' ? { flag: gate.flag } : {}),
    }
  }

  const serpKey = serpSnapshotKey({ query: input.query, locale: input.locale, depth: config.serp_top_n })
  let snapshot = await findFreshSerpSnapshot(deps.db, system, serpKey, now)

  if (!snapshot && (input.allowSerpSpend ?? true)) {
    const bought = await deps.seo.serpTop({
      keyword: input.query,
      locale: { languageCode: input.locale.language, countryCode: input.locale.country },
      depth: config.serp_top_n,
      attribution: { kind: 'account', accountId: input.accountId },
    })
    await upsertSerpSnapshot(deps.db, system, {
      cacheKey: serpKey,
      query: input.query,
      locale: serpLocaleTag(input.locale),
      results: bought.data.map((r) => ({
        position: r.position,
        url: r.url,
        domain: r.domain,
        title: r.title,
      })),
      fetchedAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
    })
    snapshot = await findFreshSerpSnapshot(deps.db, system, serpKey, now)
  }

  if (!snapshot) {
    log.info('intent_gap.no_fresh_serp', { account_id: input.accountId, page: input.page.url })
    return { status: 'unavailable', reason: 'no_fresh_serp' }
  }

  const cacheKey = intentGapCacheKey({
    pageChecksum: input.page.checksum,
    serpCacheKey: snapshot.cacheKey,
    serpFetchedAt: snapshot.fetchedAt,
  })

  const results = resultsOf(snapshot)
    .filter((result) => result.url !== input.page.url)
    .slice(0, config.serp_top_n)

  const held = await readCachedRequest(deps.db, system, cacheKey, now)
  if (held) {
    // Replayed, not re-derived: the gap set is worked out from the stored
    // answer, so a change to the consensus floor in `packages/rules` takes
    // effect without buying the comparison again.
    const stored = held.responseJson as CoverageAnalysisOutput
    log.info('intent_gap.cache_hit', { account_id: input.accountId, page: input.page.url })
    return {
      status: 'analysed',
      analysis: {
        subtopics: groundSubtopics(stored, competitorShells(results)),
        topPagesAnalysed: results.length,
        modelId: 'replayed',
        promptVersion: deps.prompt.version,
        cacheHit: true,
        usdCost: 0,
      },
    }
  }

  const competitors: CoverageCompetitorPage[] = []
  for (const result of results) {
    try {
      const fetched = await deps.pageFetcher.fetch({ url: result.url })
      const { angle } = buildCompetitorAngle({
        url: result.url,
        domain: result.domain,
        position: result.position,
        bodyHtml: fetched.body,
      })
      competitors.push({ ...angle, title: result.title })
    } catch (error) {
      // One unreachable page is not a reason to abandon the comparison — the
      // consensus floor is read against however many we actually saw, so a
      // smaller sample makes the bar harder to clear, not easier to fake.
      log.warn('intent_gap.page_fetch_failed', {
        account_id: input.accountId,
        url: result.url,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (competitors.length === 0) {
    log.info('intent_gap.no_reachable_pages', { account_id: input.accountId, page: input.page.url })
    return { status: 'unavailable', reason: 'no_reachable_pages' }
  }

  const analysisInput: CoverageAnalysisInput = {
    accountId: input.accountId,
    query: input.query,
    ourPage: {
      url: input.page.url,
      title: input.page.title,
      headings: input.page.headings,
      excerpt: input.page.excerpt,
    },
    competitors,
  }

  const analysis = await analyseCoverage(
    { llm: deps.llm, prompt: deps.prompt },
    analysisInput,
    async (raw) => {
      await putBeforeProcessing(deps.db, system, {
        cacheKey,
        kind: 'llm',
        responseJson: raw,
        // The entry stops being reachable when the results page it was made
        // against does, because a fresher snapshot produces a different key.
        expiresAt: snapshot.expiresAt,
      })
    },
  )

  return { status: 'analysed', analysis }
}

/**
 * A cache replay knows which addresses were on the results page but never
 * fetched their contents — it does not need to, since the model's answer is
 * already made. These stand in so the same grounding filter runs on both paths.
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

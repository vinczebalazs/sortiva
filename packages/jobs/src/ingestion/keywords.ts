import {
  ENRICHMENT_PAUSED_FLAG,
  accountAttribution,
  deriveSeedKeywords,
  pickDraftKeywords,
  rankCompetitorCandidates,
  serpLocaleTag,
  serpSnapshotKey,
  type DraftKeyword,
  type FamilyBrief,
  type KeywordMetric,
  type SeedKeywordsPrompt,
  type SerpResult,
} from '@sortiva/core'
import {
  BUSINESS_COMPETITOR_CAP,
  CompetitorCapReached,
  accountScope,
  addCompetitor,
  familiesForPersona,
  findFreshSerpSnapshot,
  isGlobalFlagActive,
  keywordsNeedingEnrichment,
  listCompetitors,
  listKeywords,
  readPersona,
  resultsOf,
  systemScope,
  upsertKeywords,
  upsertSerpSnapshot,
  type AccountScope,
} from '@sortiva/db'
import { rules, type DiscoveryConfig } from '@sortiva/rules'
import { RetryableFailure, TerminalFailure } from '../runtime/errors'
import { inputVersion } from '../runtime/idempotency'
import type { StepContext } from '../runtime/runStep'
import type { IngestionDeps } from './deps'
import type { StepDefinition } from './steps'

/**
 * Step seven: what this shop's customers search for, and which few businesses
 * it is up against.
 *
 * The first step in onboarding that spends money with the search-data vendor,
 * and everything about how it is written follows from that.
 *
 * **Nothing is bought twice.** A term priced inside the last month is not
 * priced again; a results page read inside the last week is not read again.
 * Underneath both of those, the vendor wrapper stores every raw response before
 * anything looks at it — so a crash between the vendor answering and this step
 * writing the answer down replays the stored response instead of paying for it
 * a second time. The three layers do different jobs: this step's own lookups
 * are the product's memory of what a term is worth, and the wrapper's cache is
 * what makes a retry free.
 *
 * **It stops rather than degrades.** If the day's search-data bill has crossed
 * its ceiling, the global enrichment switch is up and this step declines to run
 * at all — it does not fall back to a cheaper read or to older data. That
 * switch is raised by the spend sweep from our own ledger, never by the
 * analytics vendor.
 *
 * **The store's language and country decide which market we buy.** They come
 * from the business profile, which settled them from the merchant's own Shopify
 * settings and markup rather than from a model. A wrong country here does not
 * fail: it silently buys another market's search volumes, and every judgement
 * built on them is then confident and wrong.
 *
 * **A domain seen on a results page does not become a competitor by being
 * there.** The stored pages are read, counted, filtered against the marketplace
 * list and the store's own domain, and only a domain that turns up for several
 * of the store's searches is proposed — as a draft the merchant edits, badged
 * as ours, capped at five. The pages themselves stay where they are.
 */

/**
 * Where the step got to. The stored results pages are what actually make a
 * resumed run free — this records which searches got that far, so the log of a
 * resumed run says how much was left rather than starting the count over.
 */
interface KeywordsCheckpoint {
  readonly serpsDone: readonly string[]
}

export interface KeywordsCompetitorsOutput {
  readonly language: string
  readonly country: string
  readonly seedTermsProposed: number
  readonly keywordsPriced: number
  readonly keywordsKept: number
  /** Terms already priced inside their lifetime, so no purchase was made for them. */
  readonly keywordsAlreadyFresh: number
  readonly serpsRead: number
  readonly serpsFromCache: number
  readonly competitorsProposed: number
  readonly promptVersion: string
  readonly modelId: string
  readonly cacheHit: boolean
}

export const keywordsCompetitorsStep: StepDefinition = {
  /**
   * The upstream artefact this step is a reading of: the business profile, plus
   * the families it was drawn from.
   *
   * A store whose profile has not changed asks the same questions of the vendor
   * and gets the same answers, so a redelivered job finds its work already
   * completed and returns the stored output rather than paying again.
   */
  async inputVersion(deps, accountId) {
    const scope = accountScope(accountId)
    const persona = await readPersona(deps.db, scope)
    const families = (await familiesForPersona(deps.db, scope))
      .map((family) => `${family.name}|${family.memberCount}`)
      .sort()
    return inputVersion({
      language: persona?.language ?? '',
      country: persona?.country ?? '',
      description: persona?.description ?? '',
      categories: [...(persona?.productCategories ?? [])].sort(),
      families,
    })
  },

  async execute(deps, context): Promise<KeywordsCompetitorsOutput> {
    const ctx = context as StepContext<KeywordsCheckpoint>
    const scope = accountScope(ctx.accountId)
    const discovery = rules().forLocale(null).discovery
    const now = deps.now?.() ?? new Date()

    await assertEnrichmentRunning(deps, ctx)

    const persona = await readPersona(deps.db, scope)
    if (!persona) {
      throw new TerminalFailure(
        'no_persona',
        'Keyword discovery needs the business profile; the profile step has not run.',
      )
    }
    const locale = { language: persona.language, country: persona.country }
    const domain = await deps.domains.readNormalized(ctx.accountId)
    const attribution = accountAttribution(ctx.accountId, domain)

    // Fails now rather than after the model call, so a misconfigured process
    // does not spend on the stronger tier before discovering it cannot finish.
    requireSeo(deps)
    const families = await familiesForPersona(deps.db, scope)

    const seeds = await deriveSeedKeywords(
      { llm: requireLlm(deps), prompt: requirePrompt(deps) },
      {
        accountId: ctx.accountId,
        domain: domain ?? '',
        brief: {
          language: persona.language,
          country: persona.country,
          description: persona.description,
          productCategories: persona.productCategories,
          audience: persona.audience,
          families: families.map(toFamilyBrief),
        },
        candidatesMax: discovery.seed_keywords.candidates_max,
      },
    )

    const priced = await priceTerms(deps, ctx, {
      scope,
      terms: seeds.terms,
      locale,
      discovery,
      now,
      attribution,
    })

    const draft = pickDraftKeywords(priced.metrics, discovery.seed_keywords.keep_max)
    await upsertKeywords(
      deps.db,
      scope,
      draft.map((keyword) => ({
        term: keyword.term,
        language: persona.language,
        country: persona.country,
        volume: keyword.monthlySearchVolume,
        difficulty: keyword.difficulty,
        cpcUsd: keyword.cpcUsd,
        source: 'auto' as const,
        enrichedAt: priced.pricedTerms.has(keyword.term) ? now : priced.enrichedAt.get(keyword.term) ?? null,
      })),
    )

    const serps = await readResultsPages(deps, ctx, {
      keywords: draft.slice(0, discovery.competitors.seed_serps_max),
      locale,
      discovery,
      now,
      attribution,
    })

    const proposed = await proposeCompetitors(deps, ctx, {
      scope,
      ranked: serps.ranked,
      ownDomain: domain ?? '',
      discovery,
    })

    const output: KeywordsCompetitorsOutput = {
      language: persona.language,
      country: persona.country,
      seedTermsProposed: seeds.terms.length,
      keywordsPriced: priced.pricedTerms.size,
      keywordsKept: draft.length,
      keywordsAlreadyFresh: priced.alreadyFresh,
      serpsRead: serps.read,
      serpsFromCache: serps.fromCache,
      competitorsProposed: proposed,
      promptVersion: seeds.promptVersion,
      modelId: seeds.modelId,
      cacheHit: seeds.cacheHit,
    }

    // Codes and counts. Never a search term or a competitor's name: those are
    // facts about a merchant's business and they live in their own rows.
    ctx.log.info('keywords_competitors.completed', {
      language: output.language,
      country: output.country,
      seed_terms_proposed: output.seedTermsProposed,
      keywords_priced: output.keywordsPriced,
      keywords_already_fresh: output.keywordsAlreadyFresh,
      keywords_kept: output.keywordsKept,
      serps_read: output.serpsRead,
      serps_from_cache: output.serpsFromCache,
      competitors_proposed: output.competitorsProposed,
      cache_hit: output.cacheHit,
    })

    return output
  },
}

/**
 * The spend brake, read at the moment work would start rather than when the job
 * was queued.
 *
 * Retryable rather than terminal on purpose: the switch is an operator's or the
 * spend sweep's decision that today has cost enough, and the right behaviour
 * is for this store's onboarding to wait and continue, not to be abandoned.
 * The merchant sees a delayed step, not a failed one.
 */
async function assertEnrichmentRunning(deps: IngestionDeps, ctx: StepContext): Promise<void> {
  const system = systemScope('the search-data spend ceiling is global; it has no account')
  if (await isGlobalFlagActive(deps.db, system, ENRICHMENT_PAUSED_FLAG)) {
    ctx.log.info('keywords_competitors.paused', { flag: ENRICHMENT_PAUSED_FLAG })
    throw new RetryableFailure(
      'enrichment_paused',
      'Search-data enrichment is paused. We paused this action rather than continue with lower-quality or stale data.',
    )
  }
}

interface PricedTerms {
  readonly metrics: KeywordMetric[]
  /** Terms this run actually bought a price for. */
  readonly pricedTerms: Set<string>
  /** When each already-known term was last priced, so a re-run does not reset it. */
  readonly enrichedAt: Map<string, Date | null>
  readonly alreadyFresh: number
}

/**
 * Buys search volumes for the terms nobody has priced lately, and reuses what
 * we already hold for the rest.
 *
 * One vendor request covers every term, because the vendor bills per request
 * rather than per keyword — asking about twenty terms separately would cost
 * twenty times asking about them together.
 */
async function priceTerms(
  deps: IngestionDeps,
  ctx: StepContext,
  input: {
    scope: AccountScope
    terms: readonly string[]
    locale: { language: string; country: string }
    discovery: DiscoveryConfig
    now: Date
    attribution: ReturnType<typeof accountAttribution>
  },
): Promise<PricedTerms> {
  const staleBefore = new Date(
    input.now.getTime() - input.discovery.cache.keyword_metrics_ttl_days * 24 * 60 * 60 * 1000,
  )

  const held = await listKeywords(deps.db, input.scope)
  const heldByTerm = new Map(held.map((row) => [row.term, row]))
  const due = new Set(
    (await keywordsNeedingEnrichment(deps.db, input.scope, staleBefore, input.terms)).map(
      (row) => row.term,
    ),
  )

  const metrics: KeywordMetric[] = []
  const enrichedAt = new Map<string, Date | null>()
  const toBuy: string[] = []
  let alreadyFresh = 0

  for (const term of input.terms) {
    const row = heldByTerm.get(term)
    if (row && !due.has(term)) {
      alreadyFresh += 1
      enrichedAt.set(term, row.enrichedAt)
      metrics.push({
        keyword: term,
        monthlySearchVolume: row.volume,
        competition: row.difficulty === null ? null : row.difficulty / 100,
        cpcUsd: row.cpc === null ? null : Number(row.cpc),
        monthlyHistory: [],
      })
      continue
    }
    toBuy.push(term)
  }

  const pricedTerms = new Set<string>()
  if (toBuy.length > 0) {
    const result = await requireSeo(deps).keywordMetrics({
      keywords: toBuy,
      locale: { languageCode: input.locale.language, countryCode: input.locale.country },
      attribution: input.attribution,
    })
    for (const metric of result.data) {
      metrics.push(metric)
      pricedTerms.add(metric.keyword.trim().toLowerCase())
    }
    // A term the vendor answered nothing about is still one we asked for, and
    // it is kept unpriced rather than dropped — the merchant may recognise it.
    for (const term of toBuy) {
      if (pricedTerms.has(term)) continue
      metrics.push({
        keyword: term,
        monthlySearchVolume: null,
        competition: null,
        cpcUsd: null,
        monthlyHistory: [],
      })
    }
    ctx.log.info('keywords_competitors.priced', {
      terms_asked: toBuy.length,
      cache_hit: result.meta.cacheHit,
      billable: result.meta.billable,
    })
  }

  return { metrics, pricedTerms, enrichedAt, alreadyFresh }
}

interface ResultsPages {
  readonly ranked: { keyword: string; domain: string; position: number }[]
  readonly read: number
  readonly fromCache: number
}

/**
 * Reads a results page for each of the store's strongest searches, reusing any
 * we already hold inside their week.
 *
 * Checkpointed after every search, because ten vendor calls at a second or two
 * each is comfortably past the point where a crash should mean starting over.
 * The checkpoint holds only the searches already stored — the pages themselves
 * are in the database, so resuming re-reads them from there.
 */
async function readResultsPages(
  deps: IngestionDeps,
  ctx: StepContext<KeywordsCheckpoint>,
  input: {
    keywords: readonly DraftKeyword[]
    locale: { language: string; country: string }
    discovery: DiscoveryConfig
    now: Date
    attribution: ReturnType<typeof accountAttribution>
  },
): Promise<ResultsPages> {
  const system = systemScope('a results page is keyed by the search, not by the store that asked')
  const depth = input.discovery.competitors.serp_position_max
  const ttlMs = input.discovery.cache.serp_snapshot_ttl_days * 24 * 60 * 60 * 1000

  const done = new Set(ctx.checkpoint?.serpsDone ?? [])
  const ranked: { keyword: string; domain: string; position: number }[] = []
  let read = 0
  let fromCache = 0

  for (const keyword of input.keywords) {
    const cacheKey = serpSnapshotKey({ query: keyword.term, locale: input.locale, depth })

    const held = await findFreshSerpSnapshot(deps.db, system, cacheKey, input.now)
    if (held) {
      fromCache += 1
      ranked.push(...toRankedRows(keyword.term, resultsOf(held)))
      done.add(keyword.term)
      continue
    }

    // A resumed run that finds no fresh snapshot for a search it had already
    // done means the snapshot expired mid-run, which is a reason to read it
    // again rather than to skip it — so `done` is not consulted here. It exists
    // so the *loop* can be resumed, and the stored page is what makes that free.
    const result = await requireSeo(deps).serpTop({
      keyword: keyword.term,
      locale: { languageCode: input.locale.language, countryCode: input.locale.country },
      depth,
      attribution: input.attribution,
    })
    read += 1

    await upsertSerpSnapshot(deps.db, system, {
      cacheKey,
      query: keyword.term,
      locale: serpLocaleTag(input.locale),
      results: result.data.map(toStoredResult),
      fetchedAt: input.now,
      expiresAt: new Date(input.now.getTime() + ttlMs),
    })

    ranked.push(...toRankedRows(keyword.term, result.data))
    done.add(keyword.term)
    await ctx.save({ serpsDone: [...done] })

    if (ctx.signal.aborted) break
  }

  return { ranked, read, fromCache }
}

/**
 * Fills the store's draft competitor list.
 *
 * Every domain here has already been through the ranking function's filters:
 * not the store itself, not on the marketplace list, on the first page, and
 * seen for several different searches. What is added is a draft the merchant
 * removes from, badged as ours rather than theirs. Hitting the database's cap
 * mid-way stops the loop instead of failing the step — five is five, and a
 * store that already has competitors from a previous run is not a problem to
 * report.
 */
async function proposeCompetitors(
  deps: IngestionDeps,
  ctx: StepContext,
  input: {
    scope: AccountScope
    ranked: readonly { keyword: string; domain: string; position: number }[]
    ownDomain: string
    discovery: DiscoveryConfig
  },
): Promise<number> {
  const existing = await listCompetitors(deps.db, input.scope)
  const room = BUSINESS_COMPETITOR_CAP - existing.length
  if (room <= 0) return 0

  const candidates = rankCompetitorCandidates({
    ranked: input.ranked,
    ownDomain: input.ownDomain,
    existingDomains: existing.map((row) => row.domainNormalized),
    positionMax: input.discovery.competitors.serp_position_max,
    appearsInKeywordsMin: input.discovery.competitors.appears_in_keywords_min,
    limit: Math.min(room, input.discovery.competitors.auto_proposed_max),
  })

  let added = 0
  for (const candidate of candidates) {
    try {
      await addCompetitor(deps.db, input.scope, {
        domainNormalized: candidate.domain,
        source: 'auto',
      })
      added += 1
    } catch (error) {
      if (error instanceof CompetitorCapReached) break
      throw error
    }
  }

  ctx.log.info('keywords_competitors.proposed', {
    candidates: candidates.length,
    added,
    already_held: existing.length,
  })
  return added
}

function toRankedRows(
  keyword: string,
  results: readonly { domain: string; position: number }[],
): { keyword: string; domain: string; position: number }[] {
  return results.map((result) => ({
    keyword,
    domain: result.domain,
    position: result.position,
  }))
}

function toStoredResult(result: SerpResult) {
  return {
    position: result.position,
    url: result.url,
    domain: result.domain,
    title: result.title,
  }
}

function toFamilyBrief(family: {
  name: string
  memberCount: number
  differentiationAxes: readonly string[]
  mergedFacts: FamilyBrief['mergedFacts']
}): FamilyBrief {
  return {
    name: family.name,
    memberCount: family.memberCount,
    differentiationAxes: family.differentiationAxes,
    mergedFacts: family.mergedFacts,
  }
}

function requireSeo(deps: IngestionDeps) {
  if (!deps.seo) {
    throw new TerminalFailure(
      'no_seo_provider',
      'Keyword discovery needs the search-data provider; the process did not supply one.',
    )
  }
  return deps.seo
}

function requireLlm(deps: IngestionDeps) {
  if (!deps.llm) {
    throw new TerminalFailure(
      'no_llm_client',
      'Seed keywords need the instrumented model client; the process did not supply one.',
    )
  }
  return deps.llm
}

function requirePrompt(deps: IngestionDeps): SeedKeywordsPrompt {
  if (!deps.seedsPrompt) {
    throw new TerminalFailure(
      'no_seeds_prompt',
      'Seed keywords need their versioned prompt; the process did not supply one.',
    )
  }
  return deps.seedsPrompt
}

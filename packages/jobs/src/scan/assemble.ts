import type {
  CannibalizationInput,
  CompetitorGapCandidate,
  CompetitorGapInput,
  ContentDecayInput,
  DetectionWindow,
  ExistingCoverage,
  FamilyCoverageCandidate,
  FamilyCoverageInput,
  FamilyMappingCandidate,
  KeywordCandidate,
  Logger,
  LowCtrInput,
  MetadataInput,
  MetadataPage,
  PageFact,
  QueryCluster,
  RichnessGapCandidate,
  RichnessGapInput,
  SeoDataProvider,
  StrikingDistanceInput,
  WeeklyShareRow,
} from '@sortiva/core'
import {
  brandTokens,
  classifyKeywordIntent,
  earlierWindowToken,
  indexPages,
  isLimitedIntelligence,
  mapKeywordToFamilies,
  serpLocaleTag,
  serpSnapshotKey,
  standardCurve,
  substanceInventory,
  toIsoDate,
  windowToken,
} from '@sortiva/core'
import {
  accountScope,
  confirmedKeywords,
  findDomainForAccount,
  findFreshSerpSnapshot,
  findGscConnForAccount,
  gscPageQueryTotals,
  latestCtrCurve,
  listCompetitors,
  listFamilies,
  listQueryClusters,
  listLiveStorePages,
  listTopProducts,
  productSubstanceForFamilies,
  readPersona,
  rankedDomainsForQueries,
  resultsOf,
  systemScope,
  upsertSerpSnapshot,
  type Db,
} from '@sortiva/db'
import type { RulesLayer } from '@sortiva/rules'
import { rebuildQueryClustersForAccount } from './clusters'
import { DbExistingTargetCheck } from './existing-target'
import { runtimeLogger } from '../runtime/logging'

/**
 * Turning one store's real rows into exactly what every P0 detector
 * (`packages/core/src/signals`) already declares it needs — the part of the
 * pipeline the pure functions in `packages/core` deliberately hold no opinion
 * about, per that package's own boundary rule (it "cannot import Next, React,
 * or any provider SDK").
 *
 * Every field below is either present because the store genuinely has the
 * data (GSC connected, competitors added, a fresh SERP snapshot on hand) or
 * absent/empty because it honestly does not — never guessed. Limited
 * Intelligence mode (main §7.11) is the caller's own branch, not a flag this
 * module reads: `assembleGscInputs` is simply not called when there is no
 * live Search Console connection, and the four GSC-dependent signals produce
 * nothing that pass.
 */

export interface AssembleDeps {
  readonly db: Db
  readonly seo: SeoDataProvider
  readonly rules: RulesLayer
  readonly now?: () => Date
  readonly logger?: Logger
}

/** Every window this scan reasons about, derived once so every detector agrees on "now". */
export interface ScanWindows {
  readonly current: DetectionWindow
  readonly decayBaseline: DetectionWindow
  readonly cannibalizationBaseline: DetectionWindow
}

function isoRange(end: Date, days: number): { start: string; end: string; window: DetectionWindow } {
  const endDate = new Date(end)
  const startDate = new Date(end)
  startDate.setUTCDate(startDate.getUTCDate() - days + 1)
  return {
    start: toIsoDate(startDate),
    end: toIsoDate(endDate),
    window: { startDate: toIsoDate(startDate), endDate: toIsoDate(endDate), days },
  }
}

function shiftEnd(end: Date, days: number): Date {
  const shifted = new Date(end)
  shifted.setUTCDate(shifted.getUTCDate() - days)
  return shifted
}

export function computeScanWindows(deps: AssembleDeps, windowDays: number): ScanWindows {
  const now = (deps.now ?? (() => new Date()))()
  const searchConsole = deps.rules.search_console
  const cutoff = shiftEnd(now, searchConsole.data_lag_days)
  const current = isoRange(cutoff, windowDays).window
  const decayBaseline = isoRange(
    shiftEnd(cutoff, deps.rules.signals.content_decay.comparison_window_offset_weeks * 7),
    windowDays,
  ).window
  const cannibalizationBaseline = isoRange(
    shiftEnd(cutoff, deps.rules.signals.cannibalization.baseline_offset_weeks * 7),
    windowDays,
  ).window
  return { current, decayBaseline, cannibalizationBaseline }
}

async function pageFacts(db: Db, accountId: string): Promise<{ pages: readonly PageFact[]; index: ReturnType<typeof indexPages> }> {
  const scope = accountScope(accountId)
  const rows = await listLiveStorePages(db, scope)
  const pages: PageFact[] = rows.map((row) => ({
    url: row.url,
    pageType: row.pageType,
    intentClass: row.intentClass,
  }))
  return { pages, index: indexPages(pages) }
}

async function totalsFor(
  db: Db,
  accountId: string,
  window: DetectionWindow,
  minImpressions: number,
): Promise<{ page: string; query: string; clicks: number; impressions: number; position: number | null }[]> {
  return gscPageQueryTotals(
    db,
    accountScope(accountId),
    { startDate: window.startDate, endDate: window.endDate },
    minImpressions,
  )
}

/** Splits a 28-day window into (up to) four 7-day weeks, oldest first — what cannibalization's leader-alternation test reads. */
async function weeklyTotalsFor(
  db: Db,
  accountId: string,
  window: DetectionWindow,
  minImpressions: number,
): Promise<WeeklyShareRow[]> {
  const start = new Date(`${window.startDate}T00:00:00.000Z`)
  const weeks: DetectionWindow[] = []
  for (let offset = 0; offset < window.days; offset += 7) {
    const weekStart = new Date(start)
    weekStart.setUTCDate(weekStart.getUTCDate() + offset)
    const weekEnd = new Date(weekStart)
    weekEnd.setUTCDate(weekEnd.getUTCDate() + Math.min(6, window.days - offset - 1))
    weeks.push({
      startDate: toIsoDate(weekStart),
      endDate: toIsoDate(weekEnd),
      days: Math.min(7, window.days - offset),
    })
  }

  const out: WeeklyShareRow[] = []
  for (const week of weeks) {
    const rows = await totalsFor(db, accountId, week, minImpressions)
    for (const row of rows) out.push({ ...row, weekStart: week.startDate })
  }
  return out
}

export interface GscAssembly {
  readonly strikingDistance: StrikingDistanceInput
  readonly lowCtr: LowCtrInput
  readonly decay: ContentDecayInput
  readonly cannibalization: CannibalizationInput
}

/**
 * Everything the four Search-Console-dependent P0 detectors need. Never
 * called when the store has no live GSC connection — the caller's branch,
 * not this function's.
 */
export async function assembleGscInputs(
  deps: AssembleDeps,
  accountId: string,
  windows: ScanWindows,
): Promise<GscAssembly> {
  const db = deps.db
  const now = (deps.now ?? (() => new Date()))().toISOString()
  const { index: pages } = await pageFacts(db, accountId)
  const minImpressions = deps.rules.clusters.min_query_impressions

  // Clusters have to be current at the moment this scan reads them — nothing
  // else rebuilds them on a schedule of its own (`clusters.ts`'s own doc
  // comment names the weekly scan, this card, as the caller). Skipped rather
  // than thrown when there is no live GSC connection: `rebuildQueryClustersForAccount`
  // reads that state itself and answers `not_connected`, and this function is
  // never called in that branch anyway (the caller in `run.ts` only invokes
  // it once `accountIsLimitedIntelligence` is false).
  await rebuildQueryClustersForAccount(
    { db, ...(deps.now ? { now: deps.now } : {}), ...(deps.logger ? { logger: deps.logger } : {}) },
    accountId,
  )
  const clusterRows = await listQueryClusters(db, accountScope(accountId))
  const clusters = clusterRows.map((row) => ({
    headQuery: row.headQuery,
    memberQueries: row.memberQueries,
    clusterId: row.clusterId,
  }))

  const currentRows = await totalsFor(db, accountId, windows.current, minImpressions)

  const curveRow = await latestCtrCurve(db, accountScope(accountId))
  const curve = curveRow
    ? { curve: curveRow.curveJson as Record<string, number>, source: 'fitted' as const, windowDays: deps.rules.ctr_curve.window_days }
    : { curve: standardCurve(deps.rules.ctr_curve), source: 'standard' as const, windowDays: deps.rules.ctr_curve.window_days }

  const domain = await findDomainForAccount(db, accountScope(accountId))
  const brand = domain ? brandTokens({ domainNormalized: domain.domainNormalized }) : []

  const decayCurrentRows = currentRows
  const decayBaselineRows = await totalsFor(db, accountId, windows.decayBaseline, minImpressions)
  const priorConsecutiveEvaluations = await priorDecayEvaluations(deps, accountId, windows, pages)

  const cannibalizationWeekly = await weeklyTotalsFor(db, accountId, windows.current, minImpressions)
  const cannibalizationBaseline = await totalsFor(db, accountId, windows.cannibalizationBaseline, minImpressions)

  return {
    strikingDistance: {
      clusters,
      rows: currentRows,
      pages,
      config: deps.rules.signals.striking_distance,
      window: windows.current,
      fetchedAt: now,
    },
    lowCtr: {
      clusters,
      rows: currentRows,
      pages,
      curve,
      brandTokens: brand,
      config: deps.rules.signals.low_ctr_at_strong_rank,
      window: windows.current,
      fetchedAt: now,
    },
    decay: {
      rows: decayCurrentRows,
      baselineRows: decayBaselineRows,
      pages,
      config: deps.rules.signals.content_decay,
      window: windows.current,
      baselineWindow: windows.decayBaseline,
      priorConsecutiveEvaluations,
      fetchedAt: now,
    },
    cannibalization: {
      clusters,
      rows: currentRows,
      weeklyRows: cannibalizationWeekly,
      baselineRows: cannibalizationBaseline,
      pages,
      config: deps.rules.signals.cannibalization,
      window: windows.current,
      fetchedAt: now,
    },
  }
}

/**
 * How many *immediately preceding* weeks also cleared content decay's raw
 * thresholds for each page — derived fresh from GSC history already retained
 * (tech spec §2.1: 16 months of `gsc_query_daily`) rather than a new table.
 *
 * `T3.4`'s own decision journal (2026-09-02) named this exact gap and left it
 * for this card, offering two homes: a column on the open opportunity row, or
 * a new weekly-observations table (a migration this card may not make).
 * Neither is used. A page's decay math is a pure function of a shifted GSC
 * window, and the window a week ago is data this store already has — so the
 * count is recomputed, not stored, and needs no schema at all. Bounded cost:
 * `consecutive_weekly_evaluations_min` is 2 in `signals.config.yaml` today,
 * so this runs the raw test over exactly one extra week per scan.
 * See DECISIONS 2026-09-03 T3.7.
 */
async function priorDecayEvaluations(
  deps: AssembleDeps,
  accountId: string,
  windows: ScanWindows,
  pages: ReturnType<typeof indexPages>,
): Promise<Map<string, number>> {
  const config = deps.rules.signals.content_decay
  const weeksNeeded = Math.max(0, config.consecutive_weekly_evaluations_min - 1)
  const counts = new Map<string, number>()
  if (weeksNeeded === 0) return counts

  const minImpressions = deps.rules.clusters.min_query_impressions
  const now = (deps.now ?? (() => new Date()))().toISOString()
  const { detectContentDecay } = await import('@sortiva/core')

  for (let offset = 1; offset <= weeksNeeded; offset += 1) {
    const shiftBy = offset * 7
    const window = {
      startDate: toIsoDate(shiftEnd(new Date(`${windows.current.startDate}T00:00:00.000Z`), shiftBy)),
      endDate: toIsoDate(shiftEnd(new Date(`${windows.current.endDate}T00:00:00.000Z`), shiftBy)),
      days: windows.current.days,
    }
    const baselineWindow = {
      startDate: toIsoDate(shiftEnd(new Date(`${windows.decayBaseline.startDate}T00:00:00.000Z`), shiftBy)),
      endDate: toIsoDate(shiftEnd(new Date(`${windows.decayBaseline.endDate}T00:00:00.000Z`), shiftBy)),
      days: windows.decayBaseline.days,
    }
    const rows = await totalsFor(deps.db, accountId, window, minImpressions)
    const baselineRows = await totalsFor(deps.db, accountId, baselineWindow, minImpressions)
    const result = detectContentDecay({
      rows,
      baselineRows,
      pages,
      config,
      window,
      baselineWindow,
      fetchedAt: now,
    })
    const passed = new Set([...result.detections, ...result.provisional].map((s) => s.page))

    if (offset === 1) {
      for (const page of passed) counts.set(page, 1)
    } else {
      for (const [page, streak] of [...counts.entries()]) {
        if (streak === offset - 1 && passed.has(page)) counts.set(page, offset)
      }
    }
  }
  return counts
}

/**
 * The store's confirmed keywords, turned into the shared `KeywordCandidate`
 * shape three of the four catalogue/market P0 detectors read — with the
 * heuristic intent/family classification from `keyword-classify.ts` filling
 * the two fields `keywords` itself cannot answer. See DECISIONS 2026-09-03
 * T3.7 for why a heuristic is what stands here.
 */
export async function assembleKeywordCandidates(
  deps: AssembleDeps,
  accountId: string,
): Promise<readonly KeywordCandidate[]> {
  const scope = accountScope(accountId)
  const [keywords, families] = await Promise.all([
    confirmedKeywords(deps.db, scope),
    listFamilies(deps.db, scope),
  ])
  const mappingFamilies: FamilyMappingCandidate[] = families.map((f) => ({
    id: f.id,
    name: f.name,
    differentiationAxes: f.differentiationAxes,
  }))

  return keywords.map((keyword) => ({
    keyword: keyword.term,
    monthlySearchVolume: keyword.volume,
    intentClass: classifyKeywordIntent(keyword.term),
    familyIds: mapKeywordToFamilies(keyword.term, mappingFamilies),
    // `keywords.source` (schema wave 2) only tracks `auto`/`manual` — a
    // coarser distinction than `KeywordCandidate.source`'s three-way split,
    // which nothing downstream branches on (it only ever reaches an
    // evidence fact). `manual` (the merchant typed it) maps to the closest
    // read, `merchant_seed`; `auto` (Sonnet-seeded, DataForSEO-expanded, or
    // competitor-derived — the pipeline does not keep the three apart
    // either) maps to `related_expansion`.
    source: keyword.source === 'manual' ? ('merchant_seed' as const) : ('related_expansion' as const),
  }))
}

/**
 * `uncovered_commercial_query`'s own input: every confirmed-keyword
 * candidate unfiltered (the detector applies `mapped_families_min`, the
 * demand floor and the commercial-intent filter itself — that is its job,
 * not this assembler's), which families clear the substance floor, and what
 * the existing-target check found for each candidate the detector could
 * plausibly need it for.
 *
 * The existing-target check is itself a real read (and, in Limited
 * Intelligence mode, a billable one), so it only runs for a candidate with
 * *any* family clearing the substance floor — a safe superset of what
 * `mapped_families_min` will actually keep: every candidate the detector
 * would go on to check `coverage` for is checked here, and the (small) extra
 * ones the detector will discard for a different reason cost one wasted
 * lookup, never a missing one (which would throw `UncheckedCandidateError`).
 */
export async function assembleUncoveredQueryInput(
  deps: AssembleDeps,
  accountId: string,
  candidates: readonly KeywordCandidate[],
): Promise<{
  candidates: readonly KeywordCandidate[]
  coverage: ReadonlyMap<string, ExistingCoverage>
  familiesWithSubstance: ReadonlySet<string>
}> {
  const scope = accountScope(accountId)
  const families = await listFamilies(deps.db, scope)
  const familiesWithSubstance = new Set<string>()
  const check = new DbExistingTargetCheck({ db: deps.db, seo: deps.seo, ...(deps.now ? { now: deps.now } : {}), ...(deps.logger ? { logger: deps.logger } : {}) })
  const coverage = new Map<string, ExistingCoverage>()

  const config = deps.rules.gates.substance_floor
  for (const family of families) {
    const products = await productSubstanceForFamilies(deps.db, scope, [family.id])
    const inventory = substanceInventory(products, config)
    if (inventory.passes) familiesWithSubstance.add(family.id)
  }

  const worthChecking = candidates.filter((c) => c.familyIds.some((id) => familiesWithSubstance.has(id)))
  for (const candidate of worthChecking) {
    const cluster: QueryCluster = {
      head: candidate.keyword,
      members: [],
      intentClass: candidate.intentClass,
      familyIds: candidate.familyIds,
    }
    const outcome = await check.full(cluster, accountId)
    coverage.set(
      candidate.keyword,
      outcome.match
        ? { strength: outcome.match.strength, ...(outcome.match.url ? { url: outcome.match.url } : {}) }
        : { strength: 'none' },
    )
  }

  return { candidates, coverage, familiesWithSubstance }
}

/**
 * `competitor_coverage_gap`'s input: for each confirmed keyword, where each
 * business competitor ranks and where we do, read off a fresh SERP snapshot —
 * fetching one, cost-ordered and cached exactly like `T2.6`'s own onboarding
 * step (same cache key convention, `serpSnapshotKey`, so the two share a
 * cache row rather than each paying for their own), only for candidates that
 * already have a mapped family (the cheap filter §9.6.4 asks to run before
 * any billable spend).
 */
export async function assembleCompetitorGapInput(
  deps: AssembleDeps,
  accountId: string,
  candidates: readonly KeywordCandidate[],
  allowSpend: boolean,
): Promise<CompetitorGapInput> {
  const scope = accountScope(accountId)
  const system = systemScope('competitor coverage gap reads SERP snapshots keyed by the search, not the store')
  const now = (deps.now ?? (() => new Date()))()
  const persona = await readPersona(deps.db, scope)
  const competitors = await listCompetitors(deps.db, scope)
  const domain = await findDomainForAccount(deps.db, scope)

  const eligible = candidates.filter((c) => c.familyIds.length > 0)
  const depth = deps.rules.discovery.competitors.serp_position_max
  const ttlMs = deps.rules.discovery.cache.serp_snapshot_ttl_days * 24 * 60 * 60 * 1000
  const locale = persona ? { language: persona.language, country: persona.country } : { language: 'en', country: 'US' }

  const cacheKeys: string[] = []
  for (const candidate of eligible) {
    const cacheKey = serpSnapshotKey({ query: candidate.keyword, locale, depth })
    cacheKeys.push(cacheKey)
    const held = await findFreshSerpSnapshot(deps.db, system, cacheKey, now)
    if (held || !allowSpend || !persona) continue

    const result = await deps.seo.serpTop({
      keyword: candidate.keyword,
      locale: { languageCode: locale.language, countryCode: locale.country },
      depth,
      attribution: { kind: 'account', accountId },
    })
    await upsertSerpSnapshot(deps.db, system, {
      cacheKey,
      query: candidate.keyword,
      locale: serpLocaleTag(locale),
      results: result.data.map((r) => ({ position: r.position, url: r.url, domain: r.domain, title: r.title })),
      fetchedAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
    })
  }

  const ranked = await rankedDomainsForQueries(deps.db, system, { cacheKeys, now })
  const byKeyword = new Map<string, { domain: string; position: number; url: string }[]>()
  for (const row of ranked) {
    const list = byKeyword.get(row.keyword) ?? []
    list.push({ domain: row.domain, position: row.position, url: '' })
    byKeyword.set(row.keyword, list)
  }

  const ourRanked = domain ? await ourSerpPositions(deps, accountId, eligible, locale, depth) : new Map<string, { position: number; url: string }>()
  const competitorDomains = new Set(competitors.map((c) => c.domainNormalized))

  const gapCandidates: CompetitorGapCandidate[] = eligible.map((candidate) => ({
    ...candidate,
    competitorRankings: (byKeyword.get(candidate.keyword) ?? []).filter((r) => competitorDomains.has(r.domain)),
    ourPosition: ourRanked.get(candidate.keyword)?.position ?? null,
    ourUrl: ourRanked.get(candidate.keyword)?.url ?? null,
  }))

  return { candidates: gapCandidates, config: deps.rules.signals.competitor_coverage_gap, fetchedAt: now.toISOString() }
}

/** Where the store itself sits in the same fresh snapshots — read from the same cached page, not a second vendor call. */
async function ourSerpPositions(
  deps: AssembleDeps,
  accountId: string,
  candidates: readonly KeywordCandidate[],
  locale: { language: string; country: string },
  depth: number,
): Promise<Map<string, { position: number; url: string }>> {
  const db = deps.db
  const system = systemScope('reading our own position out of the same SERP snapshot competitor-gap already holds')
  const domain = await findDomainForAccount(db, accountScope(accountId))
  const now = (deps.now ?? (() => new Date()))()
  const out = new Map<string, { position: number; url: string }>()
  if (!domain) return out

  for (const candidate of candidates) {
    const cacheKey = serpSnapshotKey({ query: candidate.keyword, locale, depth })
    const held = await findFreshSerpSnapshot(db, system, cacheKey, now)
    if (!held) continue
    const ours = resultsOf(held).find((r) => r.domain === domain.domainNormalized)
    if (ours) out.set(candidate.keyword, { position: ours.position, url: ours.url })
  }
  return out
}

/** `product_family_coverage_gap`'s input, with a real revenue-share computed from the store's own best-seller list. */
export async function assembleFamilyCoverageInput(
  deps: AssembleDeps,
  accountId: string,
  keywordCandidates: readonly KeywordCandidate[],
): Promise<FamilyCoverageInput> {
  const scope = accountScope(accountId)
  const now = (deps.now ?? (() => new Date()))().toISOString()
  const [families, topProducts, storePagesRows] = await Promise.all([
    listFamilies(deps.db, scope),
    listTopProducts(deps.db, scope),
    listLiveStorePages(deps.db, scope),
  ])

  const productFamilyById = new Map<string, string>()
  // `topProducts` carries our product id but not its family; `products.familyId`
  // is read through `productSubstanceForFamilies`'s own join for the families
  // we already need substance for, so the (small, ≤ family count) per-family
  // reads below double as the revenue lookup's join too.
  const revenueByFamily = new Map<string, number>()
  let totalRevenue = 0
  for (const product of topProducts) totalRevenue += product.revenue90d ? Number(product.revenue90d) : 0

  for (const family of families) {
    const members = await productSubstanceForFamilies(deps.db, scope, [family.id])
    for (const member of members) productFamilyById.set(member.productId, family.id)
  }
  for (const product of topProducts) {
    const familyId = productFamilyById.get(product.productId)
    if (!familyId) continue
    revenueByFamily.set(familyId, (revenueByFamily.get(familyId) ?? 0) + (product.revenue90d ? Number(product.revenue90d) : 0))
  }
  const topSellerFamilies = new Set([...productFamilyById.values()])

  const keywordCountByFamily = new Map<string, number>()
  const config = deps.rules.gates.demand_floor
  for (const candidate of keywordCandidates) {
    const clears = candidate.monthlySearchVolume !== null && candidate.monthlySearchVolume >= config.monthly_search_volume_min
    if (!clears) continue
    for (const familyId of candidate.familyIds) {
      keywordCountByFamily.set(familyId, (keywordCountByFamily.get(familyId) ?? 0) + 1)
    }
  }

  const candidates: FamilyCoverageCandidate[] = families.map((family) => ({
    familyId: family.id,
    familyName: family.name,
    isTopSeller: topSellerFamilies.has(family.id),
    revenueShare: totalRevenue > 0 ? (revenueByFamily.get(family.id) ?? 0) / totalRevenue : 0,
    // A page "mentions" this family once `store_pages.family_ids` names it —
    // that column exists (schema wave 2) and nothing writes it yet (the same
    // open gap `T3.4`/`T3.5` already named for `intent_class`), so this reads
    // as empty on every real store today, the safe direction (never hides a
    // real gap; can only over-detect one). Flagged, not fixed — not this
    // card's column to populate.
    mappedContent: storePagesRows
      .filter((page) => page.familyIds.includes(family.id))
      .map((page) => ({ url: page.url, kind: page.pageType === 'article_ours' ? ('ours' as const) : ('store' as const), ranks: false })),
    keywordCandidatesClearingFloor: keywordCountByFamily.get(family.id) ?? 0,
    // No single keyword to read an intent off a whole-range gap — buying_guide
    // is the broadest, least-assuming article shape for "nothing at all is
    // written about this range yet". See DECISIONS 2026-09-03 T3.7.
    intentClass: 'buying_guide',
  }))

  return { candidates, config: deps.rules.signals.product_family_coverage_gap, fetchedAt: now }
}

/** `catalog_richness_gap`'s input: the same keyword candidates, this store's substance inventory per mapped family, and the winnability constant every CREATE-family signal in this card uses (see DECISIONS 2026-09-03 T3.6, the precedent this follows). */
export async function assembleRichnessGapInput(
  deps: AssembleDeps,
  accountId: string,
  keywordCandidates: readonly KeywordCandidate[],
): Promise<RichnessGapInput> {
  const scope = accountScope(accountId)
  const now = (deps.now ?? (() => new Date()))().toISOString()
  const winnability = deps.rules.gates.winnability.limited_intelligence_constant

  const candidates: RichnessGapCandidate[] = []
  for (const candidate of keywordCandidates) {
    if (candidate.familyIds.length === 0) continue
    const products = await productSubstanceForFamilies(deps.db, scope, candidate.familyIds)
    const substance = substanceInventory(products, deps.rules.gates.substance_floor)
    candidates.push({ ...candidate, winnability, substance })
  }

  return { candidates, gates: deps.rules.gates, fetchedAt: now }
}

/** `missing_or_weak_metadata`'s input: the content inventory's collections and products, as they stand today. */
export async function assembleMetadataInput(deps: AssembleDeps, accountId: string): Promise<MetadataInput> {
  const rows = await listLiveStorePages(deps.db, accountScope(accountId))
  const now = (deps.now ?? (() => new Date()))().toISOString()
  const pages: MetadataPage[] = rows.map((row) => ({
    url: row.url,
    pageType: row.pageType,
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
  }))
  return { pages, fetchedAt: now }
}

/** Whether this account has a live Search Console connection right now — the branch every caller reads before touching `assembleGscInputs`. */
export async function accountIsLimitedIntelligence(deps: AssembleDeps, accountId: string): Promise<boolean> {
  const connection = await findGscConnForAccount(deps.db, accountScope(accountId))
  return isLimitedIntelligence(connection ?? null)
}

export function scanLogger(deps: AssembleDeps): Logger {
  return deps.logger ?? runtimeLogger()
}

export { windowToken, earlierWindowToken }

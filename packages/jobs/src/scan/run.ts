import type pg from 'pg'
import {
  buildOpportunityDraft,
  detectCannibalization,
  detectCatalogRichnessGaps,
  detectCompetitorCoverageGaps,
  detectContentDecay,
  detectFamilyCoverageGaps,
  detectLowCtrAtStrongRank,
  detectMetadataProblems,
  detectStrikingDistance,
  detectUncoveredCommercialQueries,
  opportunityDetected,
  opportunityStatusChanged,
  rankByImpact,
  reconcileStatusWithPreconditions,
  signalRunCompleted,
  accountAttribution,
  type CtrCurve,
  type DetectedSignal,
  type Logger,
  type PosthogCapture,
  type SeoDataProvider,
} from '@sortiva/core'
import {
  accountScope,
  expireOpportunity,
  findOpportunityById,
  findSignalRun,
  insertOpportunityTasks,
  latestGscQueryDay,
  listOpenOpportunities,
  readPersona,
  transitionOpportunityStatus,
  upsertOpportunity,
  writeSignalRun,
  type Db,
  type OpportunityRow,
} from '@sortiva/db'
import { rules as loadRules, type RulesOverrideReader, type SignalType } from '@sortiva/rules'
import { withAccountLock } from '../runtime/lock'
import { mayAccountWorkRun } from '../runtime/gate'
import { runtimeLogger } from '../runtime/logging'
import {
  accountIsLimitedIntelligence,
  assembleCompetitorGapInput,
  assembleFamilyCoverageInput,
  assembleGscInputs,
  assembleKeywordCandidates,
  assembleMetadataInput,
  assembleRichnessGapInput,
  assembleUncoveredQueryInput,
  computeScanWindows,
  type AssembleDeps,
} from './assemble'
import { readIntentGapSignals } from './intent-gap'
import { TableRulesOverrideReader } from './rules-overrides'

/**
 * The whole decision pipeline (main §7.5 steps 1–7) run for one account: read
 * the store, run every P0 detector that applies, score and rank the results,
 * and reconcile them onto the `opportunities` table. This is what the
 * onboarding run, the weekly scan and an event-driven run all share — they
 * differ only in `kind`, the `run_id` they derive, and what they do
 * afterward (seed the calendar; nothing; nothing, respectively).
 *
 * **Chaos safety, stated once.** No interior checkpoint. The whole pass is
 * safe to re-run from the top after a kill because every write it makes is
 * already naturally idempotent: `upsertOpportunity` is `ON CONFLICT DO
 * UPDATE` on the same partial unique index invariant 10 requires, task rows
 * are written only on a row's first sighting (`created`), status
 * reconciliation is a guarded transition, and expiry is a guarded transition
 * too. The `signal_runs` row itself is written exactly once, at the very
 * end, as a single upsert keyed on `(account_id, run_id)` — so a kill
 * mid-pass leaves no row (or an unfinished one from a prior attempt) and a
 * retry simply redoes the same idempotent work and overwrites it with the
 * same final counts. `T3.4`'s own precedent for "no checkpoint" is the same
 * reasoning: a step whose own write reconciles onto the same result needs no
 * separate crash protection (`packages/jobs/src/ingestion/families.ts`).
 */

export interface RunSignalScanDeps {
  readonly db: Db
  readonly pool: pg.Pool
  readonly seo: SeoDataProvider
  readonly capture: Pick<PosthogCapture, 'capture'>
  readonly now?: () => Date
  readonly logger?: Logger
  /**
   * Called right after each opportunity row is persisted (created, updated,
   * reconciled or expired) — never consulted by production code, and never a
   * point this scan resumes from. Its only caller is the chaos scenario
   * (`packages/jobs/src/chaos/signal-scan.scenario.ts`), which throws through
   * it to prove the design this whole module states in its own doc comment:
   * no interior checkpoint is needed because a kill anywhere in this loop and
   * a fresh re-run from the top converge on the identical end state, by
   * construction of every write being naturally idempotent.
   */
  readonly onOpportunityPersisted?: (entityRef: string) => void
  /** Where the thresholds an operator has moved for this store come from. Defaults to the table. */
  readonly rulesOverrides?: RulesOverrideReader
}

export type SignalRunKind = 'onboarding' | 'weekly' | 'event'

export interface SignalRunOutcome {
  readonly status: 'completed' | 'already_completed' | 'paused'
  readonly runId: string
  readonly kind: SignalRunKind
  readonly signalsEvaluated: number
  readonly opportunitiesCreated: number
  readonly opportunitiesUpdated: number
  readonly opportunitiesExpired: number
  readonly pausedFlag?: string
}

/** Only an `indexing_issue` FIX on the same URL counts as the "blocking kind" main §7.9 names (indexing, canonical) — cannibalization's own FIX is structural work on the cluster, not a technical block on a URL. */
function blockingFixLookup(open: readonly OpportunityRow[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>()
  for (const row of open) {
    if (row.signalType === 'indexing_issue' && row.recommendedAction === 'fix') {
      map.set(row.entityRef, 'indexing_issue')
    }
  }
  return map
}

/** The P0 signal types this scan can detect at all — the fixed set `signal_runs.signals_evaluated` counts against. */
const CATALOG_SIGNAL_TYPES: readonly SignalType[] = [
  'uncovered_commercial_query',
  'competitor_coverage_gap',
  'product_family_coverage_gap',
  'catalog_richness_gap',
  'missing_or_weak_metadata',
]
/**
 * The statuses this pass may retire a row out of — named once, used both to
 * choose the rows and to guard the write that retires one.
 *
 * Deliberately short of the full open set. A `scheduled` or `executing` row has
 * been taken over by the calendar or by a recommendation being generated, and
 * expiring it from under that work would strand it. Both states come back to
 * one of these three when the work finishes or refuses, and a later scan
 * retires them then.
 */
const EXPIRABLE_STATUSES: readonly OpportunityRow['status'][] = ['new', 'accepted', 'blocked']

const GSC_SIGNAL_TYPES: readonly SignalType[] = [
  'striking_distance',
  'low_ctr_at_strong_rank',
  'content_decay',
  'cannibalization',
  // Not itself a Search Console measurement, but the shortlist that reaches it
  // is: a page qualifies by sitting between positions 4 and 20 for one of the
  // store's query clusters, which is Google's own record of what it showed. A
  // store without that record has no shortlist, so this is evaluated in the
  // same branch as the four above.
  'existing_page_intent_gap',
]

export async function runSignalScan(
  deps: RunSignalScanDeps,
  accountId: string,
  kind: SignalRunKind,
  runId: string,
  options: { readonly allowSerpSpend?: boolean } = {},
): Promise<SignalRunOutcome> {
  const log = deps.logger ?? runtimeLogger()

  const gate = await mayAccountWorkRun(deps.db, accountId, log)
  if (!gate.allowed) {
    log.info('signal_scan.paused', { account_id: accountId, run_id: runId, kind, reason: gate.reason })
    return {
      status: 'paused',
      runId,
      kind,
      signalsEvaluated: 0,
      opportunitiesCreated: 0,
      opportunitiesUpdated: 0,
      opportunitiesExpired: 0,
      ...(gate.reason === 'paused' ? { pausedFlag: gate.flag } : {}),
    }
  }

  const existing = await findSignalRun(deps.db, accountScope(accountId), runId)
  if (existing?.finishedAt) {
    log.info('signal_scan.already_completed', { account_id: accountId, run_id: runId, kind })
    return {
      status: 'already_completed',
      runId,
      kind,
      signalsEvaluated: existing.signalsEvaluated,
      opportunitiesCreated: existing.opportunitiesCreated,
      opportunitiesUpdated: existing.opportunitiesUpdated,
      opportunitiesExpired: existing.opportunitiesExpired,
    }
  }

  return withAccountLock(deps.pool, accountId, async () => runSignalScanLocked(deps, accountId, kind, runId, options))
}

async function runSignalScanLocked(
  deps: RunSignalScanDeps,
  accountId: string,
  kind: SignalRunKind,
  runId: string,
  options: { readonly allowSerpSpend?: boolean },
): Promise<SignalRunOutcome> {
  const log = deps.logger ?? runtimeLogger()
  const startedAt = (deps.now ?? (() => new Date()))()
  const scope = accountScope(accountId)

  const persona = await readPersona(deps.db, scope)
  // An operator can move a threshold for one store without a deploy, and this
  // is where that takes effect. The version stamped on everything below comes
  // back from the same call, so a row whose numbers were moved says so and a
  // row on the repo file's numbers is stamped exactly as it was before.
  // A malformed override throws rather than being skipped: a threshold that
  // quietly fails to apply is worse than one that was never set.
  const overrideReader = deps.rulesOverrides ?? new TableRulesOverrideReader(deps.db)
  const overrides = await overrideReader.read({
    accountId,
    ...(persona?.language ? { locale: persona.language } : {}),
  })
  const resolvedRules = loadRules().resolve({
    accountId,
    ...(persona?.language ? { locale: persona.language } : {}),
    overrides,
  })
  const layer = resolvedRules.layer
  const rulesVersion = resolvedRules.rulesVersion
  if (resolvedRules.appliedOverrides.length > 0) {
    log.info('signal_scan.rules_overridden', {
      account_id: accountId,
      run_id: runId,
      rules_version: rulesVersion,
      keys: resolvedRules.appliedOverrides.map((applied) => applied.key),
    })
  }
  const assembleDeps: AssembleDeps = {
    db: deps.db,
    seo: deps.seo,
    rules: layer,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  }

  const limitedIntelligence = await accountIsLimitedIntelligence(assembleDeps, accountId)
  const windows = computeScanWindows(assembleDeps, layer.signals.striking_distance.window_days)
  const evaluatedTypes = limitedIntelligence ? CATALOG_SIGNAL_TYPES : [...CATALOG_SIGNAL_TYPES, ...GSC_SIGNAL_TYPES]

  // Retiring a search-data opportunity says the evidence stopped holding, and
  // we may only say that while we can still see the evidence. A store whose
  // newest day of search data falls before the window this pass measured has
  // had its supply stop — the Google grant died, the sync stalled, the
  // connection was never made — and every signal reading that window then looks
  // exactly as it would if every page had come right at once. Retiring on that
  // reading would take down a merchant's whole board on the strength of a
  // broken pipe. So nothing search-driven is retired while the supply is out.
  //
  // The bar is the whole window rather than a fraction of it, because choosing
  // a fraction would be choosing a number, and numbers live in `packages/rules`.
  // The cost of the coarse bar: a sync that stopped part-way through the window
  // still allows expiry, on thinner data than usual.
  const latestSearchDay = await latestGscQueryDay(deps.db, scope)
  const searchDataCoversWindow = latestSearchDay !== null && latestSearchDay >= windows.current.startDate

  const signals: DetectedSignal[] = []
  let ctrCurve: CtrCurve | undefined
  let intentGapReEvaluated: ReadonlySet<string> = new Set<string>()
  let intentGapInBand: ReadonlySet<string> = new Set<string>()
  let intentGapLivePages: ReadonlySet<string> = new Set<string>()

  if (!limitedIntelligence) {
    const gsc = await assembleGscInputs(assembleDeps, accountId, windows)
    signals.push(...detectStrikingDistance(gsc.strikingDistance).detections)
    signals.push(...detectLowCtrAtStrongRank(gsc.lowCtr).detections)
    signals.push(...detectContentDecay(gsc.decay).detections)
    signals.push(...detectCannibalization(gsc.cannibalization).detections)
    ctrCurve = gsc.lowCtr.curve.curve

    // Free, and deliberately so: the page comparisons this reads were bought by
    // a scheduled pass of its own the day before, so nothing here fetches a
    // page or calls a model. A page with no stored comparison is passed over —
    // this scan never buys one, because one slow fetch would hold up every
    // other signal for this store.
    const intentGap = await readIntentGapSignals(
      { db: deps.db, ...(deps.now ? { now: deps.now } : {}), logger: log },
      {
        accountId,
        clusters: gsc.strikingDistance.clusters,
        rows: gsc.strikingDistance.rows,
        pages: gsc.strikingDistance.pages,
        // The same fallback the paying pass uses. Both sides put the market
        // into the search identity, so a difference here would mean looking
        // under a key nothing was written under.
        locale: persona
          ? { language: persona.language, country: persona.country }
          : { language: 'en', country: 'US' },
      },
    )
    signals.push(...intentGap.signals)
    intentGapReEvaluated = intentGap.reEvaluated
    intentGapInBand = intentGap.inBand
    intentGapLivePages = intentGap.livePages
  }

  const keywordCandidates = await assembleKeywordCandidates(assembleDeps, accountId)
  const uncovered = await assembleUncoveredQueryInput(assembleDeps, accountId, keywordCandidates)
  signals.push(
    ...detectUncoveredCommercialQueries({
      candidates: uncovered.candidates,
      coverage: uncovered.coverage,
      familiesWithSubstance: uncovered.familiesWithSubstance,
      config: layer.signals.uncovered_commercial_query,
      gates: layer.gates,
      fetchedAt: startedAt.toISOString(),
    }),
  )

  const competitorGapInput = await assembleCompetitorGapInput(
    assembleDeps,
    accountId,
    keywordCandidates,
    options.allowSerpSpend ?? true,
  )
  signals.push(...detectCompetitorCoverageGaps(competitorGapInput))

  const familyCoverageInput = await assembleFamilyCoverageInput(assembleDeps, accountId, keywordCandidates)
  signals.push(...detectFamilyCoverageGaps(familyCoverageInput))

  const richnessInput = await assembleRichnessGapInput(assembleDeps, accountId, keywordCandidates)
  signals.push(...detectCatalogRichnessGaps(richnessInput))

  const metadataInput = await assembleMetadataInput(assembleDeps, accountId)
  signals.push(...detectMetadataProblems(metadataInput))

  const openBeforeThisPass = await listOpenOpportunities(deps.db, scope)
  const openTechnicalBlockers = blockingFixLookup(openBeforeThisPass)

  const patternClamp = { min: layer.learning.patterns.multiplier_clamp_min, max: layer.learning.patterns.multiplier_clamp_max }
  const drafts = signals.map((signal) => {
    const entityRef = entityRefOf(signal)
    return buildOpportunityDraft(
      signal,
      {
        accountId,
        limitedIntelligence,
        rulesVersion,
        // No calibrated winnability model exists anywhere in this codebase
        // yet — Gate 1's own calibration is Lane D's territory and every
        // CREATE-family caller in this product, `T3.6` included, passes the
        // same conservative constant rather than build a second one. See
        // DECISIONS 2026-09-03 T3.6 (the precedent) and 2026-09-03 T3.7.
        winnability: layer.gates.winnability.limited_intelligence_constant,
        ...(ctrCurve ? { ctrCurve } : {}),
        patternMultipliers: [],
        patternMultiplierClamp: patternClamp,
        detectedAt: startedAt.toISOString(),
        technicalBlocker: entityRef ? openTechnicalBlockers.get(entityRef) ?? null : null,
      },
      layer.scoring,
    )
  })

  const ranked = rankByImpact(drafts, layer.scoring.impact)

  let created = 0
  let updated = 0
  let expired = 0
  const attribution = accountAttribution(accountId)
  const detectedEntityRefsByType = new Map<string, Set<string>>()

  for (const draft of ranked) {
    const set = detectedEntityRefsByType.get(draft.signalType) ?? new Set<string>()
    set.add(draft.entityRef)
    detectedEntityRefsByType.set(draft.signalType, set)

    const { row, created: isNew } = await upsertOpportunity(deps.db, scope, draft, startedAt)
    if (isNew) {
      created += 1
      await insertOpportunityTasks(deps.db, row.id, draft.tasks)
      deps.capture.capture(opportunityDetected(attribution, draft))
    } else {
      updated += 1
      const reconciled = reconcileStatusWithPreconditions(row.status, draft.recommendedAction, draft.preconditions.length === 0)
      if (reconciled) {
        const moved = await transitionOpportunityStatus(deps.db, scope, row.id, { from: [row.status], to: reconciled.to })
        if (moved) {
          log.info('signal_scan.status_reconciled', {
            account_id: accountId,
            opportunity_id: row.id,
            signal_type: row.signalType,
            from: row.status,
            to: reconciled.to,
          })
          deps.capture.capture(
            opportunityStatusChanged(attribution, { from: row.status, to: reconciled.to, actor: 'autopilot' }),
          )
        }
      }
    }
    deps.onOpportunityPersisted?.(draft.entityRef)
  }

  // Expiry: an open row of a signal type this pass evaluated, whose entity
  // this pass did not re-detect at all, no longer holds. `EXPIRABLE_STATUSES`
  // is the same lane boundary `reconcileStatusWithPreconditions` draws (see
  // DECISIONS 2026-09-03 T3.7): once a row is `scheduled`/`executing` it has a
  // `topics` row and belongs to Lane D's calendar state machine, not a
  // signal-detection pass.
  let heldOpenWithoutSearchData = 0
  for (const row of openBeforeThisPass) {
    // The two cheap disqualifications first, so that everything counted below
    // is a row this pass would otherwise have retired. A count that also
    // included rows the calendar had taken over, or rows this pass detected
    // again, would say "held back" about rows nothing was going to touch.
    if (!EXPIRABLE_STATUSES.includes(row.status)) continue
    if (detectedEntityRefsByType.get(row.signalType)?.has(row.entityRef)) continue

    const signalType = row.signalType as SignalType
    const evaluated = evaluatedTypes.includes(signalType)
    if (GSC_SIGNAL_TYPES.includes(signalType)) {
      // Held open rather than retired, and counted, so a store sitting like
      // this is visible instead of merely quiet. Either the store has no
      // Search Console connection — in which case this pass evaluated none of
      // these types and has nothing to say about them — or the connection has
      // stopped supplying days that reach the window judged above. Holding is
      // also what lets §7.11's promise work: a store that reconnects has its
      // existing opportunities re-scored, which needs them still to be there.
      //
      // The cost, stated rather than discovered: a store that never reconnects
      // keeps these cards for as long as it stays disconnected. Nothing here
      // ages them out, and choosing how long a card may outlive its evidence is
      // a product decision nobody has made.
      if (!evaluated || !searchDataCoversWindow) {
        heldOpenWithoutSearchData += 1
        continue
      }
    } else if (!evaluated) continue

    if (signalType === 'existing_page_intent_gap') {
      // The one signal this scan does not measure for itself, so it has two
      // ways out rather than one.
      //
      // Either a stored comparison was replayed for the page and reported
      // nothing missing — evidence the gap closed — or Search Console no longer
      // places the page in the band this signal is defined over at all, having
      // climbed clear of it or fallen out of it. The second is a measurement
      // this pass can read for itself, and it is the only exit for a page the
      // paying pass will never look at again precisely because it left the band.
      // Absent both, the page simply was not looked at, which is not evidence.
      //
      // A page that has left the store is excluded from the second route on
      // purpose: the nightly walk retires that one, under the reason that says
      // the merchant took the page away rather than the reason that says a
      // measurement moved. The two reasons mean different things to the
      // learning loop and only one of them is true here.
      const answered = intentGapReEvaluated.has(row.entityRef)
      const leftTheBand = intentGapLivePages.has(row.entityRef) && !intentGapInBand.has(row.entityRef)
      if (!answered && !leftTheBand) continue
    }
    const result = await expireOpportunity(
      deps.db,
      scope,
      row.id,
      'evidence_no_longer_holds',
      startedAt,
      EXPIRABLE_STATUSES,
    )
    // Somebody moved the row between the read at the top of this pass and this
    // write — into the calendar, most likely. Whatever they did with it is more
    // recent than this pass's picture of it, so this leaves it alone rather
    // than retiring work that has already started.
    if (result) {
      expired += 1
      deps.capture.capture(opportunityStatusChanged(attribution, { from: row.status, to: 'expired', actor: 'expiry' }))
    }
    deps.onOpportunityPersisted?.(row.entityRef)
  }

  if (heldOpenWithoutSearchData > 0) {
    log.info('signal_scan.expiry_held_open_no_search_data', {
      account_id: accountId,
      run_id: runId,
      rows: heldOpenWithoutSearchData,
      limited_intelligence: limitedIntelligence,
      latest_search_day: latestSearchDay,
      window_start: windows.current.startDate,
    })
  }

  const finishedAt = (deps.now ?? (() => new Date()))()
  await writeSignalRun(deps.db, scope, {
    runId,
    kind,
    rulesVersion,
    signalsEvaluated: signals.length,
    opportunitiesCreated: created,
    opportunitiesUpdated: updated,
    opportunitiesExpired: expired,
    startedAt,
    finishedAt,
  })

  deps.capture.capture(
    signalRunCompleted(attribution, {
      kind,
      rulesVersion,
      signalsEvaluated: signals.length,
      opportunitiesCreated: created,
      opportunitiesUpdated: updated,
      opportunitiesExpired: expired,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    }),
  )

  log.info('signal_scan.completed', {
    account_id: accountId,
    run_id: runId,
    kind,
    limited_intelligence: limitedIntelligence,
    signals_evaluated: signals.length,
    opportunities_created: created,
    opportunities_updated: updated,
    opportunities_expired: expired,
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
  })

  return {
    status: 'completed',
    runId,
    kind,
    signalsEvaluated: signals.length,
    opportunitiesCreated: created,
    opportunitiesUpdated: updated,
    opportunitiesExpired: expired,
  }
}

/** The same entity a signal's own action selection will resolve to — read here only for the blocking-FIX lookup, never to choose an action (invariant 7: that stays `selectAction`'s job alone). */
function entityRefOf(signal: DetectedSignal): string | null {
  switch (signal.signalType) {
    case 'striking_distance':
    case 'low_ctr_at_strong_rank':
    case 'content_decay':
    case 'missing_or_weak_metadata':
    case 'existing_page_intent_gap':
    case 'indexing_issue':
      return signal.page
    case 'cannibalization':
      return signal.clusterHead
    case 'uncovered_commercial_query':
    case 'competitor_coverage_gap':
      return signal.keyword
    case 'product_family_coverage_gap':
      return signal.familyId
    case 'catalog_richness_gap':
      return signal.keyword
    default:
      return null
  }
}

export { findOpportunityById }

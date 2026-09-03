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
  listOpenOpportunities,
  readPersona,
  transitionOpportunityStatus,
  upsertOpportunity,
  writeSignalRun,
  type Db,
  type OpportunityRow,
} from '@sortiva/db'
import { rules as loadRules, type SignalType } from '@sortiva/rules'
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
const GSC_SIGNAL_TYPES: readonly SignalType[] = [
  'striking_distance',
  'low_ctr_at_strong_rank',
  'content_decay',
  'cannibalization',
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
  const layer = loadRules().forLocale(persona?.language)
  const rulesVersion = loadRules().rulesVersion
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

  const signals: DetectedSignal[] = []
  let ctrCurve: CtrCurve | undefined

  if (!limitedIntelligence) {
    const gsc = await assembleGscInputs(assembleDeps, accountId, windows)
    signals.push(...detectStrikingDistance(gsc.strikingDistance).detections)
    signals.push(...detectLowCtrAtStrongRank(gsc.lowCtr).detections)
    signals.push(...detectContentDecay(gsc.decay).detections)
    signals.push(...detectCannibalization(gsc.cannibalization).detections)
    ctrCurve = gsc.lowCtr.curve.curve
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
  }

  // Expiry: an open row of a signal type this pass evaluated, whose entity
  // this pass did not re-detect at all, no longer holds. Restricted to
  // `new`/`accepted`/`blocked` — the same lane boundary
  // `reconcileStatusWithPreconditions` draws (see DECISIONS 2026-09-03 T3.7):
  // once a row is `scheduled`/`executing` it has a `topics` row and belongs
  // to Lane D's calendar state machine, not a signal-detection pass.
  for (const row of openBeforeThisPass) {
    if (!evaluatedTypes.includes(row.signalType as SignalType)) continue
    if (row.status !== 'new' && row.status !== 'accepted' && row.status !== 'blocked') continue
    const stillDetected = detectedEntityRefsByType.get(row.signalType)?.has(row.entityRef)
    if (stillDetected) continue
    const result = await expireOpportunity(deps.db, scope, row.id, 'evidence_no_longer_holds', startedAt)
    if (result) {
      expired += 1
      deps.capture.capture(opportunityStatusChanged(attribution, { from: row.status, to: 'expired', actor: 'expiry' }))
    }
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

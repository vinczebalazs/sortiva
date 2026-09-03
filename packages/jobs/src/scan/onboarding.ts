import {
  accountAttribution,
  toContractOpportunity,
  type NotificationEmitter,
  type Opportunity,
} from '@sortiva/core'
import {
  accountScope,
  acceptedContentOpportunities as acceptedContentOpportunityRows,
  systemScope,
  transitionOpportunityStatus,
  type Db,
} from '@sortiva/db'
import { rules } from '@sortiva/rules'
import { DbTopicScheduler, TopicSchedulingError } from '../generation/topic-scheduler'
import { accountsReadyForPlanning } from '@sortiva/db'
import { runtimeLogger } from '../runtime/logging'
import { runSignalScan, type RunSignalScanDeps } from './run'

/**
 * The activation moment (main §6.9): the first full detection pass after
 * onboarding confirms, and the initial calendar it seeds from whatever it
 * finds. `run_id` is `onboarding-<accountId>` — one onboarding run per
 * account, ever, which is what makes redelivery of this exact job free
 * (`runSignalScan`'s own idempotency, `signal_runs`' unique key) and what
 * lets the sweep below poll for "has this run yet" with a single read.
 */

export interface OnboardingScanDeps extends RunSignalScanDeps {
  readonly notifications: NotificationEmitter
}

export interface OnboardingScanResult {
  readonly status: 'completed' | 'already_completed' | 'paused'
  readonly opportunitiesCreated: number
  readonly topicsScheduled: number
}

function onboardingRunId(accountId: string): string {
  return `onboarding-${accountId}`
}

export async function runOnboardingScan(
  deps: OnboardingScanDeps,
  accountId: string,
): Promise<OnboardingScanResult> {
  const log = deps.logger ?? runtimeLogger()
  const outcome = await runSignalScan(deps, accountId, 'onboarding', onboardingRunId(accountId))

  if (outcome.status === 'paused') {
    return { status: 'paused', opportunitiesCreated: 0, topicsScheduled: 0 }
  }

  // Seeding the calendar only ever runs once per account: the first call
  // that actually completed the scan does it; a redelivery that finds the
  // run already finished (`already_completed`) must not schedule the same
  // accepted opportunities a second time — `TopicScheduler.schedule()` has
  // no idempotency guard of its own (it always inserts a fresh `topics` row),
  // and the only thing that keeps `acceptedContentOpportunities()` from
  // handing back an opportunity this run already scheduled is this
  // function's own guarded transition below, out of `accepted` the moment
  // scheduling succeeds. See DECISIONS 2026-09-03 T3.7.
  const topicsScheduled = outcome.status === 'completed' ? await seedCalendar(deps, accountId, log) : 0

  if (outcome.status === 'completed') {
    await deps.notifications.emit(
      'opportunities_ready',
      { run_id: outcome.runId },
      outcome.runId,
      accountAttribution(accountId),
    )
  }

  return { status: outcome.status, opportunitiesCreated: outcome.opportunitiesCreated, topicsScheduled }
}

async function seedCalendar(deps: OnboardingScanDeps, accountId: string, log: ReturnType<typeof runtimeLogger>): Promise<number> {
  const scope = accountScope(accountId)
  const confidenceConfig = rules().defaults.scoring.confidence
  const rows = await acceptedContentOpportunityRows(deps.db, scope)
  const scheduler = new DbTopicScheduler({ db: deps.db, ...(deps.now ? { now: deps.now } : {}) })

  let scheduled = 0
  for (const row of rows) {
    const opportunity: Opportunity = toContractOpportunity(
      {
        id: row.id,
        accountId: row.accountId,
        signalType: row.signalType,
        entityType: row.entityType,
        entityRef: row.entityRef,
        evidenceJson: row.evidenceJson,
        impact: row.impact,
        impactScore: row.impactScore,
        confidence: row.confidence,
        reasonTemplateKey: row.reasonTemplateKey,
        reasonParamsJson: row.reasonParamsJson,
        recommendedAction: row.recommendedAction,
        preconditionsJson: row.preconditionsJson,
        status: row.status,
        rulesVersion: row.rulesVersion,
        limitedIntelligence: row.limitedIntelligence,
        detectedAt: row.detectedAt,
        updatedAt: row.updatedAt,
        expiredReason: row.expiredReason,
      },
      confidenceConfig,
    )

    try {
      await scheduler.schedule(opportunity)
      // `TopicScheduler.schedule()` (Lane D, `T4.2`) sets `topics.opportunity_id`
      // and `opportunities.topic_id` but never moves the opportunity's own
      // `status` — that column is `packages/core/opportunities`' table, not
      // the calendar's, and nothing else in the codebase advances it either
      // (checked: no caller anywhere transitions an opportunity to
      // `scheduled` today). Whoever calls `.schedule()` is left to complete
      // main §7.9's own edge (`accepted → scheduled`); this is this card's
      // own call doing so, immediately, in the same guarded-transition
      // discipline every other status move in this product already uses.
      // Flagged for Lane D: `T4.6`'s replenishment is the *other* real
      // caller of `.schedule()` and needs the same guarded transition on its
      // own side, or its own re-runs will hit the identical
      // double-schedule risk. See DECISIONS 2026-09-03 T3.7.
      await transitionOpportunityStatus(deps.db, scope, row.id, { from: ['accepted'], to: 'scheduled' })
      scheduled += 1
    } catch (error) {
      if (error instanceof TopicSchedulingError) {
        // Degrade to pause, never guess (main §14.4): an opportunity this
        // card cannot place — today, one lacking a usable `intent_class`
        // evidence fact — is left `accepted` rather than silently dropped.
        // It surfaces again at the next replenishment pass once Lane D
        // builds one, or at the next weekly scan's own re-detection.
        log.warn('onboarding_scan.schedule_failed', {
          account_id: accountId,
          opportunity_id: row.id,
          signal_type: row.signalType,
          error: error.message,
        })
        continue
      }
      throw error
    }
  }
  return scheduled
}

export interface OnboardingSweepDeps extends OnboardingScanDeps {}

/**
 * The sweep half of the gap `T2.1`'s and `T2.7`'s own DECISIONS entries
 * named: `confirmProfile` moves a domain to `ready_for_planning` and has no
 * port to start the next thing, because the next thing did not exist yet
 * when it was written. This polls the same state every one of this
 * codebase's other "start the next thing" sweeps already use (the monthly
 * summary, the OAuth and export-URL reminders) rather than reaching into
 * Lane A/B's confirm-profile code or route. Safe to run as often as the
 * crontab likes: `runOnboardingScan` itself is the idempotency boundary,
 * keyed on `onboarding-<accountId>` — a repeat sweep finds the run already
 * finished and does nothing.
 */
export async function sweepOnboardingRuns(
  deps: OnboardingSweepDeps,
): Promise<{ readonly considered: number; readonly started: number }> {
  const log = deps.logger ?? runtimeLogger()
  const accountIds = await accountsReadyForPlanning(
    deps.db,
    systemScope('the onboarding-run sweep looks across every confirmed account for one that has not run yet'),
  )

  let started = 0
  for (const accountId of accountIds) {
    const result = await runOnboardingScan(deps, accountId)
    if (result.status === 'completed') started += 1
  }

  log.info('onboarding_scan_sweep_complete', { considered: accountIds.length, started })
  return { considered: accountIds.length, started }
}

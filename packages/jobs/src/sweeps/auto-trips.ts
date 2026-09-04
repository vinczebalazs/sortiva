import type { AccountScope, Db } from '@sortiva/db'
import {
  accountScope,
  accountsWithVendorSpend,
  countAccountCalls,
  countOptimizeGenerationsSince,
  listActiveFlags,
  resetAccountFlag,
  systemScope,
  tripAccountFlag,
  tripGlobalFlag,
  type SpendWindow,
} from '@sortiva/db'
import {
  ACCOUNT_INTENT_GAP_PAUSED_FLAG,
  ACCOUNT_OPTIMIZE_PAUSED_FLAG,
  ALL_WORK_PAUSED_FLAG,
  AUTOMATIC_ACTOR,
  COUNT_FAILED_VENDOR_CALLS,
  KILL_SWITCH_TRIPPED_EVENT,
  MODEL_CALLS_PER_PAID_ANALYSIS_MAX,
  PUBLISHING_PAUSED_FLAG,
  PUBLISH_ERROR_MINIMUM_SAMPLE,
  UnrecordedJudgeOutcomes,
  UnrecordedPublishOutcomes,
  accountAttribution,
  callTypeCapVerdict,
  judgeFailRateVerdict,
  publishErrorRateVerdict,
  utcDayWindow,
  type JudgeOutcomeCounter,
  type Logger,
  type PosthogCapture,
  type PublishOutcomeCounter,
} from '@sortiva/core'
import { rules } from '@sortiva/rules'
import { runtimeLogger } from '../runtime/logging'

/**
 * The brakes that are not about a dollar total: quality, publishing, and one
 * store's daily allowance of a paid analysis it sets off by clicking.
 *
 * Runs inside the same job as the spend caps. It is the same act — read our own
 * counters, compare with the ceilings in `packages/rules`, raise a switch — on
 * the same five-minute clock, and splitting it into a second scheduled job
 * would have meant a second crontab entry for no behaviour anybody asked for.
 *
 * **Analytics is told, never asked.** A trip is a database write; the
 * `kill_switch_tripped` event that follows it is telemetry, and it is sent in a
 * way that cannot undo or prevent the write. If the analytics vendor is down,
 * unreachable or throwing, the switch still goes up — that is the whole point
 * of the control plane living here.
 *
 * **The two daily allowances are the exception to "a trip waits for a person".**
 * Every other switch here reports something nobody expected and stays up until
 * an operator has looked. A day's allowance is different in kind: it is a
 * condition that is true today and false tomorrow, and nobody has to decide that
 * a new day has started. So this sweep lowers those two — and only those two,
 * and only where it raised them itself — as soon as the count it complained
 * about is back inside the ceiling, which the turn of the day guarantees.
 */

/** Written into every switch this job raises, so a flag's origin is obvious. */
const ACTOR = 'auto_trip_sweep'

export interface AutoTrip {
  scope: 'account' | 'global'
  flag: string
  accountId?: string
  reason: string
  /** False when the switch was already up, so the sweep changed nothing. */
  raised: boolean
}

/** A daily allowance switch this run took back down because the day it was about has passed. */
export interface AllowanceCleared {
  flag: string
  accountId: string
}

export interface AutoTripReport {
  trips: AutoTrip[]
  /** Conditions the sweep could not evaluate because nothing records the numbers yet. */
  unmeasurable: string[]
  cleared: AllowanceCleared[]
}

export interface AutoTripDeps {
  judge?: JudgeOutcomeCounter
  publishing?: PublishOutcomeCounter
  analytics?: PosthogCapture
  now?: () => Date
  log?: Logger
}

/**
 * Tells analytics that a switch went up, and swallows anything that goes wrong
 * doing so.
 *
 * Deliberately after the write and deliberately unable to affect it: the
 * failure this shape exists to prevent is a vendor outage taking the brakes
 * with it. The log line is what keeps a silently unreported trip visible.
 */
function announce(
  deps: AutoTripDeps,
  log: Logger,
  trip: { flag: string; accountId?: string; reason: string },
): void {
  try {
    deps.analytics?.capture({
      event: KILL_SWITCH_TRIPPED_EVENT,
      attribution: accountAttribution(trip.accountId ?? 'system'),
      properties: { flag: trip.flag, tripped_by: 'auto', reason_code: ACTOR },
    })
  } catch (error) {
    log.warn('kill_switch_announce_failed', {
      flag: trip.flag,
      error_class: error instanceof Error ? error.name : 'unknown',
    })
  }
}

export async function evaluateAutoTrips(
  db: Db,
  deps: AutoTripDeps = {},
): Promise<AutoTripReport> {
  const now = deps.now?.() ?? new Date()
  const log = deps.log ?? runtimeLogger()
  const caps = rules().defaults.auto_trips
  const budgets = rules().defaults.budgets
  const system = systemScope('these ceilings are about the whole product, not one account')

  const trips: AutoTrip[] = []
  const unmeasurable: string[] = []
  const cleared: AllowanceCleared[] = []

  const raiseGlobal = async (flag: string, reason: string) => {
    const row = await tripGlobalFlag(db, system, { flag, actor: ACTOR, reason, trippedBy: 'auto' })
    trips.push({ scope: 'global', flag, reason, raised: row !== undefined })
    if (row !== undefined) {
      log.error('kill_switch_tripped', { flag, tripped_by: 'auto' })
      announce(deps, log, { flag, reason })
    }
  }

  // ── Quality ────────────────────────────────────────────────────────────────
  // Most drafts failing the judge means a prompt or a model changed under us,
  // not that the writing got worse. Everything stops and somebody is paged.
  const judge = deps.judge ?? new UnrecordedJudgeOutcomes()
  const judged = await judge.recentJudgeOutcomes(caps.judge_fail_rate.trailing_drafts)
  if (!judged.measurable) {
    unmeasurable.push('judge_fail_rate')
  } else {
    const verdict = judgeFailRateVerdict({
      rejected: judged.failures,
      graded: judged.sample,
      rateMax: caps.judge_fail_rate.rate_max,
      trailingDrafts: caps.judge_fail_rate.trailing_drafts,
    })
    if (verdict.tripped && verdict.reason) await raiseGlobal(ALL_WORK_PAUSED_FLAG, verdict.reason)
  }

  // ── Publishing ─────────────────────────────────────────────────────────────
  // Publishing failing at this rate is the platform, not us. Publishing stops;
  // writing does not.
  const publishing = deps.publishing ?? new UnrecordedPublishOutcomes()
  const published = await publishing.recentPublishOutcomes(caps.publish_error_rate.window_hours)
  if (!published.measurable) {
    unmeasurable.push('publish_error_rate')
  } else {
    const verdict = publishErrorRateVerdict({
      failed: published.failures,
      attempted: published.sample,
      rateMax: caps.publish_error_rate.rate_max,
      windowHours: caps.publish_error_rate.window_hours,
      minimumSample: PUBLISH_ERROR_MINIMUM_SAMPLE,
    })
    if (verdict.tripped && verdict.reason) await raiseGlobal(PUBLISHING_PAUSED_FLAG, verdict.reason)
  }

  // ── Per-store daily allowances ─────────────────────────────────────────────
  const dayWindow: SpendWindow = { ...utcDayWindow(now), includeFailed: COUNT_FAILED_VENDOR_CALLS }
  const allowances = allowanceRules(db, {
    dayStart: dayWindow.since,
    dayWindow,
    intentGapPerDay: budgets.intent_gap.analyses_per_account_per_day,
    optimizePerDay: budgets.optimize.generations_per_account_per_day,
  })

  const accountIds = await accountsWithVendorSpend(db, system, 'anthropic', dayWindow)
  for (const accountId of accountIds) {
    const scope = accountScope(accountId)
    for (const rule of allowances) {
      const used = await rule.count(scope)
      const verdict = callTypeCapVerdict({
        used,
        ceiling: rule.ceiling,
        what: rule.what,
        ...(rule.note === undefined ? {} : { note: rule.note }),
      })
      if (!verdict.tripped || verdict.reason === null) continue

      const row = await tripAccountFlag(db, scope, {
        flag: rule.flag,
        actor: ACTOR,
        reason: verdict.reason,
        trippedBy: 'auto',
      })
      trips.push({
        scope: 'account',
        flag: rule.flag,
        accountId,
        reason: verdict.reason,
        raised: row !== undefined,
      })
      if (row !== undefined) {
        log.error('kill_switch_tripped', {
          account_id: accountId,
          flag: rule.flag,
          tripped_by: 'auto',
          used,
        })
        announce(deps, log, { flag: rule.flag, accountId, reason: verdict.reason })
      }
    }
  }

  // ── Yesterday's allowances come back ───────────────────────────────────────
  // Walked over the switches that are up rather than over the accounts that
  // spent today, because the store this is about has typically spent nothing
  // today — that is exactly why its allowance is free again.
  for (const row of await listActiveFlags(db, system)) {
    if (row.scope !== 'account' || row.accountId === null) continue
    // Only what this sweep raised itself. An operator who paused one store's
    // recommendations has a reason we know nothing about, and it is not ours to
    // decide that reason has expired.
    if (row.trippedBy !== AUTOMATIC_ACTOR || row.actor !== ACTOR) continue
    const rule = allowances.find((candidate) => candidate.flag === row.flag)
    if (!rule) continue

    const scope = accountScope(row.accountId)
    if ((await rule.count(scope)) > rule.ceiling) continue
    const lowered = await resetAccountFlag(db, scope, { flag: rule.flag, resetBy: ACTOR })
    if (lowered === undefined) continue

    cleared.push({ flag: rule.flag, accountId: row.accountId })
    log.info('kill_switch_cleared', {
      account_id: row.accountId,
      flag: rule.flag,
      reset_by: ACTOR,
    })
  }

  if (unmeasurable.length > 0) {
    // Not "nothing went wrong" — "nobody is writing it down". Said every run,
    // because a brake that cannot see is the kind of gap that goes unnoticed
    // precisely because everything looks calm.
    log.warn('auto_trip_unmeasurable', { conditions: unmeasurable })
  }

  return { trips, unmeasurable, cleared }
}

interface AllowanceRule {
  readonly flag: string
  /** Today's usage for one store, in whatever unit `ceiling` is written in. */
  readonly count: (scope: AccountScope) => Promise<number>
  readonly ceiling: number
  /** The unit both numbers are in, for the operator who reads the incident. */
  readonly what: string
  readonly note?: string
}

/**
 * What each of the two allowances counts, and against what.
 *
 * **Work the merchant asked for, not calls we made.** One OPTIMIZE generation
 * can be up to four model calls — the writer's answer, a re-ask when it comes
 * back in an unreadable shape, and the same pair again when our own checks
 * reject the first attempt. Counting calls therefore let a single recommendation
 * read as four, which is how a store with an allowance of two had the feature
 * switched off on its first click of the day.
 *
 * OPTIMIZE has a row per generation to count, and it is counted with the same
 * function the button itself uses, so the brake and the button can never
 * disagree about how much of the day's allowance is gone. Intent-gap has no row
 * per analysis anywhere — the only durable record is the ledger — so it still
 * counts model calls, and its ceiling leaves room for the wrapper's one re-ask
 * accordingly. The incident says so rather than quietly reporting calls as
 * analyses.
 */
function allowanceRules(
  db: Db,
  input: {
    dayStart: Date
    dayWindow: SpendWindow
    intentGapPerDay: number
    optimizePerDay: number
  },
): readonly AllowanceRule[] {
  return [
    {
      flag: ACCOUNT_INTENT_GAP_PAUSED_FLAG,
      count: (scope) => countAccountCalls(db, scope, 'intent_gap', input.dayWindow),
      ceiling: input.intentGapPerDay * MODEL_CALLS_PER_PAID_ANALYSIS_MAX,
      what: 'paid model calls for intent-gap analyses',
      note:
        `The store's allowance is ${input.intentGapPerDay} analyses a day, and one analysis costs ` +
        `up to ${MODEL_CALLS_PER_PAID_ANALYSIS_MAX} model calls when the first answer comes back ` +
        'in a shape we cannot read.',
    },
    {
      flag: ACCOUNT_OPTIMIZE_PAUSED_FLAG,
      count: (scope) => countOptimizeGenerationsSince(db, scope, input.dayStart),
      ceiling: input.optimizePerDay,
      what: 'OPTIMIZE generations',
    },
  ]
}

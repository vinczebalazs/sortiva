import type { Db } from '@sortiva/db'
import {
  accountScope,
  accountsWithVendorSpend,
  countAccountCalls,
  systemScope,
  tripAccountFlag,
  tripGlobalFlag,
  type SpendWindow,
} from '@sortiva/db'
import {
  ACCOUNT_INTENT_GAP_PAUSED_FLAG,
  ACCOUNT_OPTIMIZE_PAUSED_FLAG,
  ALL_WORK_PAUSED_FLAG,
  COUNT_FAILED_VENDOR_CALLS,
  KILL_SWITCH_TRIPPED_EVENT,
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

export interface AutoTripReport {
  trips: AutoTrip[]
  /** Conditions the sweep could not evaluate because nothing records the numbers yet. */
  unmeasurable: string[]
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
  // Counted out of the same ledger the dollar caps read, so the two can never
  // disagree about what a store did today.
  const dayWindow: SpendWindow = { ...utcDayWindow(now), includeFailed: COUNT_FAILED_VENDOR_CALLS }
  const perType = [
    {
      callType: 'intent_gap',
      flag: ACCOUNT_INTENT_GAP_PAUSED_FLAG,
      cap: budgets.intent_gap.analyses_per_account_per_day,
      what: 'intent-gap analyses',
    },
    {
      callType: 'optimize_reco',
      flag: ACCOUNT_OPTIMIZE_PAUSED_FLAG,
      cap: budgets.optimize.generations_per_account_per_day,
      what: 'OPTIMIZE generations',
    },
  ]

  const accountIds = await accountsWithVendorSpend(db, system, 'anthropic', dayWindow)
  for (const accountId of accountIds) {
    const scope = accountScope(accountId)
    for (const rule of perType) {
      const used = await countAccountCalls(db, scope, rule.callType, dayWindow)
      const verdict = callTypeCapVerdict({ used, cap: rule.cap, what: rule.what })
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

  if (unmeasurable.length > 0) {
    // Not "nothing went wrong" — "nobody is writing it down". Said every run,
    // because a brake that cannot see is the kind of gap that goes unnoticed
    // precisely because everything looks calm.
    log.warn('auto_trip_unmeasurable', { conditions: unmeasurable })
  }

  return { trips, unmeasurable }
}

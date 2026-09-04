import type { Db } from '@sortiva/db'
import {
  accountScope,
  accountsWithVendorSpend,
  dailyAccountVendorSpend,
  sumAccountVendorSpend,
  sumPreviewSpend,
  sumVendorSpend,
  systemScope,
  tripAccountFlag,
  tripGlobalFlag,
  type SpendWindow,
} from '@sortiva/db'
import {
  ACCOUNT_PAUSED_FLAG,
  COUNT_FAILED_VENDOR_CALLS,
  ENRICHMENT_PAUSED_FLAG,
  PREVIEW_PAUSED_FLAG,
  accountSpendVerdict,
  globalSpendVerdict,
  trailingWindow,
  utcDayWindow,
  type Logger,
} from '@sortiva/core'
import { rules } from '@sortiva/rules'
import { runtimeLogger } from '../runtime/logging'
import { registerTask } from '../runtime/tasks'
import { evaluateAutoTrips, type AutoTripDeps } from './auto-trips'

/**
 * Reads the day's spending out of our own ledger, compares it with the ceilings
 * in `packages/rules`, and raises a switch when one is crossed.
 *
 * Nothing else in the product looks at how much has been spent. Until this job
 * runs, the meter turns and nobody reads it.
 *
 * Three ceilings, three blast radiuses:
 *
 * - one account's model spend for the day — pauses that account only;
 * - the whole product's search-data spend for the day — pauses enrichment
 *   everywhere, because that bill is one bill;
 * - the whole product's logged-out preview spend for the day — pauses the
 *   preview endpoint only, which keeps the funnel alive on cached answers and
 *   never touches a paying store.
 *
 * None of the three is ever lowered automatically. Something crossed a money
 * ceiling; a person decides whether that was a bug, abuse, or a ceiling set too
 * low. (The two per-store daily allowances in `auto-trips.ts`, which runs in the
 * same job, are the one exception and say why there.)
 */

export const SPEND_CAP_SWEEP_TASK = 'spend_cap_sweep'

/** Written into every switch this job raises, so a flag's origin is obvious. */
const ACTOR = 'spend_cap_sweep'

export interface SpendCapTrip {
  scope: 'account' | 'global'
  flag: string
  /** Present for an account trip. */
  accountId?: string
  todayUsd: number
  reason: string
  /** False when the switch was already up, so the sweep changed nothing. */
  raised: boolean
}

export interface SpendCapSweepReport {
  accountsChecked: number
  trips: SpendCapTrip[]
}

export interface SpendCapSweepOptions {
  now?: () => Date
  log?: Logger
}

export async function evaluateSpendCaps(
  db: Db,
  options: SpendCapSweepOptions = {},
): Promise<SpendCapSweepReport> {
  const now = options.now?.() ?? new Date()
  const log = options.log ?? runtimeLogger()
  const caps = rules().defaults.auto_trips
  const system = systemScope('spend ceilings are measured across every account and the preview')

  const today = utcDayWindow(now)
  const dayWindow: SpendWindow = { ...today, includeFailed: COUNT_FAILED_VENDOR_CALLS }
  const trips: SpendCapTrip[] = []

  const accountIds = await accountsWithVendorSpend(db, system, 'anthropic', dayWindow)
  for (const accountId of accountIds) {
    const scope = accountScope(accountId)
    const todayUsd = await sumAccountVendorSpend(db, scope, 'anthropic', dayWindow)
    const earlier = await dailyAccountVendorSpend(db, scope, 'anthropic', {
      ...trailingWindow(now, caps.account_llm_spend.trailing_median_window_days),
      includeFailed: COUNT_FAILED_VENDOR_CALLS,
    })

    const verdict = accountSpendVerdict({
      todayUsd,
      earlierDailyTotalsUsd: earlier.map((d) => d.usdCost),
      hardCapUsdPerDay: caps.account_llm_spend.hard_cap_usd_per_day,
      medianMultipleMax: caps.account_llm_spend.trailing_median_multiple_max,
    })
    if (!verdict.tripped || verdict.reason === null) continue

    const row = await tripAccountFlag(db, scope, {
      flag: ACCOUNT_PAUSED_FLAG,
      actor: ACTOR,
      reason: verdict.reason,
      trippedBy: 'auto',
    })
    trips.push({
      scope: 'account',
      flag: ACCOUNT_PAUSED_FLAG,
      accountId,
      todayUsd,
      reason: verdict.reason,
      raised: row !== undefined,
    })
    if (row !== undefined) {
      log.error('spend_cap_tripped', {
        account_id: accountId,
        flag: ACCOUNT_PAUSED_FLAG,
        rule: verdict.rule,
        usd_today: todayUsd,
      })
    }
  }

  const globals: { flag: string; todayUsd: number; capUsdPerDay: number; what: string }[] = [
    {
      flag: ENRICHMENT_PAUSED_FLAG,
      todayUsd: await sumVendorSpend(db, system, 'dataforseo', dayWindow),
      capUsdPerDay: caps.dataforseo_spend.global_cap_usd_per_day,
      what: 'Search-data spend across all accounts',
    },
    {
      flag: PREVIEW_PAUSED_FLAG,
      todayUsd: await sumPreviewSpend(db, system, dayWindow),
      capUsdPerDay: caps.preview_spend.global_cap_usd_per_day,
      what: 'Logged-out preview spend',
    },
  ]

  for (const candidate of globals) {
    const verdict = globalSpendVerdict(candidate)
    if (!verdict.tripped || verdict.reason === null) continue

    const row = await tripGlobalFlag(db, system, {
      flag: candidate.flag,
      actor: ACTOR,
      reason: verdict.reason,
      trippedBy: 'auto',
    })
    trips.push({
      scope: 'global',
      flag: candidate.flag,
      todayUsd: candidate.todayUsd,
      reason: verdict.reason,
      raised: row !== undefined,
    })
    if (row !== undefined) {
      log.error('spend_cap_tripped', { flag: candidate.flag, usd_today: candidate.todayUsd })
    }
  }

  return { accountsChecked: accountIds.length, trips }
}

let registered = false

/**
 * Joins the sweep to the worker's task list. The schedule that would call it
 * lives in `crontab.ts`; registering the handler does not by itself switch that
 * schedule on, because the worker refuses to enable cron until every scheduled
 * job has a handler and most do not yet.
 *
 * Takes a factory rather than a database handle so that registering at process
 * start does not open a connection pool: a process that never runs a job — a
 * local UI session with the worker switched off — should not need a database to
 * boot.
 */
export function registerOpsTasks(getDb: () => Db, deps: AutoTripDeps = {}): void {
  if (registered) return
  registered = true
  registerTask(SPEND_CAP_SWEEP_TASK, async () => {
    const db = getDb()
    // Both halves of the same act: read our own counters, compare with the
    // ceilings, raise a switch. The money ceilings run first because a runaway
    // bill is the condition with no upper bound, and each half raises its own
    // switches independently — a failure in one must not leave the other
    // unevaluated.
    await evaluateSpendCaps(db)
    await evaluateAutoTrips(db, deps)
  })
}

/** Test-only: the registry is a module singleton and so is this latch. */
export function resetOpsTaskRegistration(): void {
  registered = false
}

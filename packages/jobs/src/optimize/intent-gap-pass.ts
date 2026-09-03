import { localClock, type ClusterDefinition, type ClusterShareRow } from '@sortiva/core'
import {
  accountScope,
  gscPageQueryTotals,
  listQueryClusters,
  readAccountSettings,
  readPersona,
} from '@sortiva/db'
import { rules } from '@sortiva/rules'
import type pg from 'pg'
import { deriveIdempotencyKey, inputVersion } from '../runtime/idempotency'
import { lookupCompletedWork, recordCompletedWork } from '../runtime/ledger'
import { withAccountLock } from '../runtime/lock'
import { runtimeLogger } from '../runtime/logging'
import { computeScanWindows, type AssembleDeps } from '../scan/assemble'
import { scanIntentGaps, type ScanIntentGapsDeps } from './scan'

/**
 * One store's pass of the paid page comparison: for each page sitting where an
 * edit could move it, buy the results page, read what ranks above it, and store
 * what those pages settle that ours does not.
 *
 * **The pass produces no signals of its own, on purpose.** What it leaves
 * behind is the cached comparison. The weekly signal scan reads that cache and
 * derives the signal for free, so a slow page fetch or a model outage delays
 * this and nothing else — the founder's decision of 2026-09-03. The signals
 * `scanIntentGaps` returns are therefore counted here and discarded; the scan
 * builds its own from the same stored answers.
 *
 * **Why there is no cursor to resume from.** A pass over ten pages runs for
 * minutes, so a crash half-way is ordinary rather than exotic. Progress is
 * already durable without a cursor: each results page is written to
 * `serp_snapshots` when it is bought and each comparison to `request_cache`
 * the moment the model answers, both before anything is done with them. A
 * restarted pass therefore replays every page it already finished for four
 * indexed reads apiece and pays for none of them again. A second record of
 * "this page is done" would be a second thing to disagree with the cache — and
 * the way it would disagree is the bad one: an entry that expired while a
 * "done" marker survived would leave the page silently never compared again,
 * and the scan finding nothing where it was told to look.
 */

/** The step name this pass's idempotency key is derived under. Derived from the store and its own date; never random. */
export const INTENT_GAP_PASS_STEP = 'intent_gap_pass'

export interface IntentGapPassDeps extends ScanIntentGapsDeps {
  /** For the advisory lock, which needs a raw connection rather than the query builder. */
  readonly pool: pg.Pool
}

/** What the ledger keeps for a finished pass, so a redelivery can answer without re-walking the shortlist. */
interface PassRecord {
  readonly shortlisted: number
  readonly analysed: number
  readonly detected: number
}

export type IntentGapPassOutcome =
  | {
      readonly status: 'completed'
      readonly date: string
      readonly shortlisted: number
      readonly analysed: number
      readonly detected: number
    }
  /** The store's allowance ran out part-way; the rest of the shortlist is deliberately left unfinished. */
  | {
      readonly status: 'paused_part_way'
      readonly date: string
      readonly shortlisted: number
      readonly analysed: number
      readonly detected: number
    }
  | { readonly status: 'already_done'; readonly date: string; readonly analysed: number }

export async function runIntentGapPassForAccount(
  deps: IntentGapPassDeps,
  accountId: string,
): Promise<IntentGapPassOutcome> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(accountId)

  return withAccountLock(deps.pool, accountId, async () => {
    const settings = await readAccountSettings(deps.db, scope)
    const date = localClock(now, settings.timezone).date

    const key = deriveIdempotencyKey(accountId, INTENT_GAP_PASS_STEP, inputVersion({ date }))
    const done = await lookupCompletedWork(deps.db, key)
    if (done) {
      const record = (done.outputRef ?? { analysed: 0 }) as PassRecord
      log.info('intent_gap.pass_already_done', { account_id: accountId, date })
      return { status: 'already_done', date, analysed: record.analysed } as const
    }

    const persona = await readPersona(deps.db, scope)
    const layer = rules().forLocale(persona?.language)
    const assembleDeps: AssembleDeps = {
      db: deps.db,
      seo: deps.seo,
      rules: layer,
      ...(deps.now ? { now: deps.now } : {}),
      logger: log,
    }

    // The same window the weekly scan reads, from the same function, so the two
    // shortlist the same pages. If they drifted apart the scan would go looking
    // for comparisons of pages this pass never had a reason to compare.
    const windows = computeScanWindows(assembleDeps, layer.signals.striking_distance.window_days)

    // The searches a store is shown for, as the weekly scan last rebuilt them.
    // Read rather than rebuilt: a cluster head is half of the cache key the
    // scan will recompute, so both halves have to be reading the same row. A
    // store that has never been scanned has no clusters and this pass does
    // nothing for it, which is correct — there is nothing to compare it on yet.
    const clusterRows = await listQueryClusters(deps.db, scope)
    const clusters: ClusterDefinition[] = clusterRows.map((row) => ({
      headQuery: row.headQuery,
      memberQueries: row.memberQueries,
      clusterId: row.clusterId,
    }))

    const shareRows: ClusterShareRow[] = await gscPageQueryTotals(
      deps.db,
      scope,
      { startDate: windows.current.startDate, endDate: windows.current.endDate },
      layer.clusters.min_query_impressions,
    )

    const result = await scanIntentGaps(
      { ...deps, logger: log },
      {
        accountId,
        clusters,
        rows: shareRows,
        locale: persona
          ? { language: persona.language, country: persona.country }
          : { language: 'en', country: 'US' },
      },
    )

    const record: PassRecord = {
      shortlisted: result.shortlisted,
      analysed: result.analysed,
      detected: result.signals.length,
    }

    // Deliberately not recorded as done when the allowance ran out mid-walk:
    // the shortlist is genuinely unfinished, and a "done" record would mean the
    // pages below the cut-off are never reached even once the allowance resets.
    if (!result.pausedPartWay) await recordCompletedWork(deps.db, key, record)

    log.info('intent_gap.pass_complete', {
      account_id: accountId,
      date,
      shortlisted: result.shortlisted,
      analysed: result.analysed,
      detected: result.signals.length,
      paused_part_way: result.pausedPartWay,
      skipped: result.skipped.length,
    })

    return {
      status: result.pausedPartWay ? ('paused_part_way' as const) : ('completed' as const),
      date,
      ...record,
    }
  })
}

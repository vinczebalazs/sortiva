import {
  backfillRanges,
  nextRange,
  rangeKey,
  type BackfillCheckpoint,
  type DateRange,
  type Logger,
} from '@sortiva/core'
import { rules } from '@sortiva/rules'
import { runtimeLogger } from '../runtime/logging'
import type { GscBackfillPayload } from './queue'
import { syncSearchConsoleRange, type GscSyncDeps } from './sync'

/**
 * The one-time import of a store's Search Console history, run one chunk at a
 * time.
 *
 * Sixteen months of page-by-query data is far too much for one job: it runs for
 * many minutes, and a deploy in the middle of it would otherwise throw the whole
 * thing away and start again. So the import is a chain — fetch one chunk, write
 * it, then hand the *rest* of the work to a fresh job carrying a note of what is
 * already done. The queue itself is the record of progress, which means a crash
 * costs one chunk rather than the whole import, and no schema is needed to
 * remember where we were.
 *
 * Redoing a chunk is harmless anyway: search rows are written over themselves,
 * so the worst a crash between "chunk written" and "next job queued" can do is
 * fetch the same days twice.
 *
 * Chunks are done newest-first. A merchant who confirms their profile while this
 * is still running already has the recent months, which is what nearly every
 * signal weighs most heavily; the older ones improve year-on-year comparisons
 * and can arrive late without holding anything up.
 */

export type GscBackfillStep =
  | {
      readonly status: 'chunk_done'
      readonly range: DateRange
      readonly rowsWritten: number
      /** The payload for the next job in the chain. */
      readonly next: GscBackfillPayload
    }
  | { readonly status: 'finished'; readonly chunks: number; readonly rowsWritten: number }
  /** No connection, or the grant died. Reporting stops here; nothing else is affected. */
  | { readonly status: 'stopped'; readonly reason: 'not_connected' | 'grant_invalid' }

export interface GscBackfillDeps extends GscSyncDeps {
  /** Overridden in tests; production reads the committed config. */
  readonly config?: {
    backfill_months: number
    backfill_chunk_days: number
    data_lag_days: number
  }
}

/**
 * Does one chunk and reports what should happen next. Deliberately does not
 * enqueue anything itself — the caller owns the queue, which keeps this
 * testable without one.
 */
export async function runGscBackfillChunk(
  deps: GscBackfillDeps,
  payload: GscBackfillPayload,
  options: { signal?: AbortSignal } = {},
): Promise<GscBackfillStep> {
  const now = deps.now ?? (() => new Date())
  const log: Logger = deps.logger ?? runtimeLogger()
  const config = deps.config ?? rules().defaults.search_console

  const ranges = backfillRanges({
    today: now(),
    backfillMonths: config.backfill_months,
    chunkDays: config.backfill_chunk_days,
    dataLagDays: config.data_lag_days,
  })

  const checkpoint: BackfillCheckpoint = {
    completed: payload.completed ?? [],
    rowsWritten: payload.rowsWritten ?? 0,
  }

  const range = nextRange(ranges, checkpoint)
  if (!range) {
    log.info('gsc_backfill_finished', {
      account_id: payload.accountId,
      chunks: checkpoint.completed.length,
      rows: checkpoint.rowsWritten,
    })
    return {
      status: 'finished',
      chunks: checkpoint.completed.length,
      rowsWritten: checkpoint.rowsWritten,
    }
  }

  const outcome = await syncSearchConsoleRange(deps, payload.accountId, range, options)
  if (outcome.status !== 'synced') return { status: 'stopped', reason: outcome.status }

  const rowsWritten = checkpoint.rowsWritten + outcome.rowsWritten
  return {
    status: 'chunk_done',
    range,
    rowsWritten: outcome.rowsWritten,
    next: {
      accountId: payload.accountId,
      completed: [...checkpoint.completed, rangeKey(range)],
      rowsWritten,
    },
  }
}

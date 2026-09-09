import type pg from 'pg'
import type { PosthogCapture } from '@sortiva/core'
import { tryWithAccountLock } from '../runtime/lock'
import { runtimeLogger } from '../runtime/logging'
import { registerTask } from '../runtime/tasks'
import { generateOptimizeRecommendation, type GenerateOptimizeDeps } from './generate'
import { measureOpportunityOutcome } from './measure'
import {
  OPPORTUNITY_OUTCOME_MEASURE_TASK,
  OPTIMIZE_GENERATE_TASK,
  type OpportunityOutcomeMeasurePayload,
  type OptimizeGeneratePayload,
} from './queue'

/**
 * The background half of "Generate recommendations".
 *
 * The button cannot do this work in the request: a generation buys a results
 * page, reads up to five competitor pages and makes two model calls, which is
 * a minute or more. So the route records that the merchant asked, and this
 * picks it up.
 *
 * All of it runs under the account's lock, like every other piece of work for a
 * store, so a generation cannot interleave with the store's nightly sync or
 * with a second generation for the same account.
 */

export interface OptimizeTaskDeps {
  readonly deps: GenerateOptimizeDeps
  /** For the advisory lock, which needs a raw connection rather than the query builder. */
  readonly getPool: () => pg.Pool
  /** Where the outcome verdict is reported. Optional: a process without it still writes the row. */
  readonly capture?: PosthogCapture
}

export function registerOptimizeTasks(input: OptimizeTaskDeps): void {
  if (registered) return
  registered = true

  registerTask(OPTIMIZE_GENERATE_TASK, async (rawPayload, helpers) => {
    const payload = rawPayload as OptimizeGeneratePayload
    const log = input.deps.logger ?? runtimeLogger()

    const outcome = await tryWithAccountLock(input.getPool(), payload.accountId, async () =>
      generateOptimizeRecommendation(input.deps, {
        accountId: payload.accountId,
        opportunityId: payload.opportunityId,
      }),
    )

    // The store is busy with something else. Hand the same work back rather
    // than parking a worker on a lock — the merchant is watching a spinner, but
    // a minute later is much better than a failure.
    if (outcome === undefined) {
      await helpers.addJob(OPTIMIZE_GENERATE_TASK, payload, {
        runAt: new Date(Date.now() + 60_000),
      })
      return
    }

    log.info('optimize_reco.finished', {
      account_id: payload.accountId,
      opportunity_id: payload.opportunityId,
      status: outcome.status,
    })
  }, 'per_account')

  /**
   * The other half of the improve-this-page promise: four weeks after the
   * merchant says they made the changes, go and see what happened.
   *
   * Registered here rather than in its own file because it is the same
   * feature's other end, built from the same store's database and taking the
   * same store's lock — and because a job registered somewhere a lane forgets
   * to call is precisely the failure this card exists to fix.
   *
   * Declared as per-account work, which the runtime enforces: it reads and
   * writes one named store's rows and nothing else, so it must serialise
   * against that store's other work rather than run alongside the nightly sync
   * that is rewriting the very inventory row it is about to read.
   *
   * The three ways this can come back without a verdict are each put back on
   * the queue rather than failed, because none of them is an error: the four
   * weeks are not up, Search Console has not caught up, or the store is busy.
   * Failing would burn a retry and eventually a dead-letter row for a job whose
   * only problem is that it is early.
   */
  registerTask(OPPORTUNITY_OUTCOME_MEASURE_TASK, async (rawPayload, helpers) => {
    const payload = rawPayload as OpportunityOutcomeMeasurePayload
    const log = input.deps.logger ?? runtimeLogger()

    const requeue = async (at: Date, why: string): Promise<void> => {
      await helpers.addJob(OPPORTUNITY_OUTCOME_MEASURE_TASK, payload, {
        runAt: at,
        // The same key the booking used, so a re-queue replaces the promise
        // rather than stacking a second measurement beside it.
        jobKey: `${OPPORTUNITY_OUTCOME_MEASURE_TASK}:${payload.opportunityId}`,
      })
      log.info('opportunity_outcome_deferred', {
        account_id: payload.accountId,
        opportunity_id: payload.opportunityId,
        reason: why,
        run_at: at.toISOString(),
      })
    }

    const outcome = await tryWithAccountLock(input.getPool(), payload.accountId, async () =>
      measureOpportunityOutcome(
        {
          db: input.deps.db,
          ...(input.capture ? { capture: input.capture } : {}),
          ...(input.deps.now ? { now: input.deps.now } : {}),
          logger: log,
        },
        { accountId: payload.accountId, opportunityId: payload.opportunityId },
      ),
    )

    // The store is busy with its own work. Nothing here is urgent — the page
    // has been sitting there for four weeks — so back off rather than park a
    // worker on the lock.
    if (outcome === undefined) {
      await requeue(new Date(Date.now() + 60 * 60_000), 'account_busy')
      return
    }

    if (outcome.status === 'too_early' || outcome.status === 'awaiting_search_data') {
      await requeue(outcome.retryAt, outcome.status)
    }
  }, 'per_account')
}

let registered = false

/** Test-only: the task registry is a module singleton, and so is this latch. */
export function resetOptimizeTaskRegistration(): void {
  registered = false
}

import type pg from 'pg'
import { tryWithAccountLock } from '../runtime/lock'
import { runtimeLogger } from '../runtime/logging'
import { registerTask } from '../runtime/tasks'
import { generateOptimizeRecommendation, type GenerateOptimizeDeps } from './generate'
import { OPTIMIZE_GENERATE_TASK, type OptimizeGeneratePayload } from './queue'

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
}

let registered = false

/** Test-only: the task registry is a module singleton, and so is this latch. */
export function resetOptimizeTaskRegistration(): void {
  registered = false
}

import { accountsWithRetryDue, systemScope, type Db } from '@sortiva/db'
import type { Logger } from '@sortiva/core'
import { runtimeLogger } from '../runtime/logging'
import { registerTask } from '../runtime/tasks'
import { enqueueIngestionDispatch } from './queue'

/**
 * The thing that comes back for a store whose onboarding stopped and asked to
 * be tried again.
 *
 * A step that fails in a way worth retrying writes down when to try again and
 * stops. Two callers ever asked a run to take its next step — the request that
 * claims a domain, and the return from the Shopify consent screen — and both
 * have long since finished by the time that moment arrives. So the retry was
 * scheduled, the progress screen said "we'll retry automatically", and nothing
 * ever did: one blip during the first catalogue read and the store sat there
 * for good, with no error anywhere and every screen looking calm.
 *
 * This is the same shape as `signal_scan_onboarding_sweep` and
 * `publish_intent_recovery_sweep`: a small periodic pass that asks the database
 * who is waiting and queues one job each. Safe to run as often as the crontab
 * likes — the job key is the account, so a store already queued keeps the one
 * job it has rather than collecting a second, and a dispatch with nothing to do
 * returns having done nothing.
 *
 * **What it deliberately does not sweep:** a run waiting for a *person*. The
 * Shopify consent screen and the profile confirmation are steps that sit still
 * by design, and queueing a job for each of them every five minutes would be
 * work that can never accomplish anything. A step reclaimed after its worker
 * died is also out of scope here and belongs with the lease work.
 */

export const INGESTION_RETRY_SWEEP_TASK = 'ingestion_retry_sweep'

export interface IngestionRetrySweepDeps {
  readonly getDb: () => Db
  readonly now?: () => Date
  readonly logger?: Logger
}

export interface IngestionRetrySweepResult {
  readonly due: number
  readonly queued: number
}

export async function sweepStalledIngestionRuns(
  deps: IngestionRetrySweepDeps,
): Promise<IngestionRetrySweepResult> {
  const db = deps.getDb()
  const log = deps.logger ?? runtimeLogger()
  const now = deps.now?.() ?? new Date()

  const accountIds = await accountsWithRetryDue(
    db,
    systemScope('the retry sweep looks across every running onboarding for one whose next attempt is due'),
    now,
  )

  let queued = 0
  for (const accountId of accountIds) {
    try {
      await enqueueIngestionDispatch(db, { accountId })
      queued += 1
    } catch (error) {
      // One store that cannot be queued must not stop the rest of the sweep
      // from being queued. The next pass is five minutes away and will try it
      // again, which is the whole point of a sweep over a one-shot nudge.
      log.error('ingestion_retry_sweep.enqueue_failed', {
        account_id: accountId,
        error_class: 'queue_unavailable',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  log.info('ingestion_retry_sweep_complete', { due: accountIds.length, queued })
  return { due: accountIds.length, queued }
}

let registered = false

export function registerIngestionRetrySweepTask(deps: IngestionRetrySweepDeps): void {
  if (registered) return
  registered = true
  registerTask(INGESTION_RETRY_SWEEP_TASK, async () => {
    await sweepStalledIngestionRuns(deps)
  }, 'fans_out')
}

/** Test-only: the task registry is a module singleton, and so is this latch. */
export function resetIngestionRetrySweepRegistration(): void {
  registered = false
}

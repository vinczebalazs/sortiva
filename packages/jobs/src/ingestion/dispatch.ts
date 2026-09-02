import { accountAttribution, recordConnectionLost } from '@sortiva/core'
import { deriveIdempotencyKey } from '../runtime/idempotency'
import { runtimeLogger } from '../runtime/logging'
import { runStep, type StepOutcome } from '../runtime/runStep'
import {
  closeRunAsSkipped,
  dispatchableSteps,
  findRunForAccount,
  type JobStepName,
} from '../runtime/steps'
import { registerTask } from '../runtime/tasks'
import type { IngestionDeps } from './deps'
import { INGESTION_STEPS, type DetectOutput } from './steps'

/**
 * What actually moves a store through onboarding.
 *
 * The domain claim writes the run and its steps and pushes nothing onto the
 * queue — deliberately, because queueing work for a handler nobody had written
 * would have created a permanently failing job. **So this dispatches from those
 * rows and never creates a run of its own.** A second run would mean a second
 * onboarding for every merchant.
 *
 * It runs the steps one at a time, in dependency order, and stops the moment one
 * does not succeed. Stopping is the normal case rather than an error: onboarding
 * pauses at the connect screen and waits for a person, and the run resumes when
 * something calls this again — the OAuth callback, a retry, a sweep.
 */

export const INGESTION_DISPATCH_TASK = 'ingestion_dispatch'

export type DispatchStopReason =
  /** Every step with a handler is done; the next one belongs to a later card. */
  | 'no_handler'
  /** Nothing is dispatchable: everything is finished, running elsewhere, or backing off. */
  | 'nothing_dispatchable'
  /** A step is waiting on the merchant. The store sits on a screen until they act. */
  | 'waiting'
  /** Another worker owns the step. */
  | 'not_claimed'
  | 'retry_scheduled'
  | 'dead_lettered'
  /** The step declined to run itself. No handler here does today. */
  | 'skipped'
  /** Shopify rejected our token; the merchant has been asked to reconnect. */
  | 'awaiting_reauth'
  /** Not a Shopify store. The run is over and the store is parked. */
  | 'parked_unsupported'

export interface DispatchResult {
  readonly jobId: string
  /** Steps this call actually executed, in order. */
  readonly executed: readonly JobStepName[]
  readonly stoppedBecause: DispatchStopReason
  readonly stoppedAt?: JobStepName
}

export interface DispatchInput {
  readonly accountId: string
  /** Optional: looked up from the account's live run when absent. */
  readonly jobId?: string
  /** Guards against a definition that somehow keeps making itself dispatchable. */
  readonly maxSteps?: number
}

export async function dispatchIngestion(
  deps: IngestionDeps,
  input: DispatchInput,
): Promise<DispatchResult | undefined> {
  const log = runtimeLogger().child({ account_id: input.accountId })
  const jobId = input.jobId ?? (await findRunForAccount(deps.db, input.accountId))?.jobId
  if (!jobId) {
    // No live run: the domain has not been claimed, or onboarding is finished.
    log.info('ingestion.no_run', { reason: 'no running ingestion job for this account' })
    return undefined
  }

  const executed: JobStepName[] = []
  const budget = input.maxSteps ?? 8

  for (let i = 0; i < budget; i += 1) {
    const candidates = await dispatchableSteps(deps.db, jobId)
    const next = candidates.find((row) => INGESTION_STEPS[row.step] !== undefined)
    if (!next) {
      return {
        jobId,
        executed,
        stoppedBecause: candidates.length === 0 ? 'nothing_dispatchable' : 'no_handler',
        ...(candidates[0] ? { stoppedAt: candidates[0].step } : {}),
      }
    }

    const definition = INGESTION_STEPS[next.step]!
    if (definition.ready && !(await definition.ready(deps, input.accountId))) {
      log.info('ingestion.waiting', { step: next.step })
      return { jobId, executed, stoppedBecause: 'waiting', stoppedAt: next.step }
    }

    const idempotencyKey = deriveIdempotencyKey(
      input.accountId,
      next.step,
      await definition.inputVersion(deps, input.accountId),
    )

    const outcome: StepOutcome = await runStep({
      db: deps.db,
      pool: deps.pool,
      accountId: input.accountId,
      jobId,
      stepId: next.id,
      idempotencyKey,
      handler: (ctx) => definition.execute(deps, ctx),
    })

    if (outcome.status !== 'succeeded') {
      if (outcome.status === 'awaiting_reauth') {
        await onTokenRejected(deps, input.accountId)
      }
      return { jobId, executed, stoppedBecause: outcome.status, stoppedAt: next.step }
    }

    executed.push(next.step)

    if (next.step === 'detect' && isUnsupported(outcome.output)) {
      // Nothing downstream can run for a store we cannot read. The remaining
      // steps become `skipped` so the progress screen stops showing work that
      // will never start; the domain claim itself is untouched.
      const skipped = await closeRunAsSkipped(deps.db, jobId)
      log.info('ingestion.parked', { skipped_steps: skipped })
      return { jobId, executed, stoppedBecause: 'parked_unsupported', stoppedAt: 'detect' }
    }
  }

  return { jobId, executed, stoppedBecause: 'nothing_dispatchable' }
}

/**
 * The token we hold stopped working part-way through a step. The store moves to
 * the reconnect screen and the merchant is told; generation and sync stop, and
 * everything already made for them stays readable.
 */
async function onTokenRejected(deps: IngestionDeps, accountId: string): Promise<void> {
  const domain = await deps.domains.readNormalized(accountId)
  await recordConnectionLost(
    {
      domains: deps.domains,
      connections: deps.connections,
      ...(deps.notifications ? { notifications: deps.notifications } : {}),
    },
    {
      accountId,
      at: deps.now?.() ?? new Date(),
      attribution: accountAttribution(accountId, domain),
    },
  )
}

function isUnsupported(output: unknown): boolean {
  return (output as DetectOutput | undefined)?.platform === 'custom_unsupported'
}

let registered = false

/**
 * Puts the dispatcher on the queue's task list.
 *
 * Called from the process's composition root, which is the only place that
 * knows the concrete Shopify client, page fetcher and database to build the
 * step dependencies from.
 */
export function registerIngestionTasks(makeDeps: () => IngestionDeps): void {
  if (registered) return
  registered = true
  registerTask(INGESTION_DISPATCH_TASK, async (payload) => {
    const { accountId, jobId } = (payload ?? {}) as { accountId?: string; jobId?: string }
    if (!accountId) throw new Error(`${INGESTION_DISPATCH_TASK} needs an accountId`)
    await dispatchIngestion(makeDeps(), { accountId, ...(jobId ? { jobId } : {}) })
  })
}

/** Test-only: the registry is a module singleton and so is this latch. */
export function resetIngestionTaskRegistration(): void {
  registered = false
}

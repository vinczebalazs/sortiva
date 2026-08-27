import type pg from 'pg'
import type { Db } from '@sortiva/db'
import { deadLetter } from './dlq'
import { classify, TokenInvalidFailure } from './errors'
import { withAccountLock } from './lock'
import { nextAttemptAt, retriesExhausted } from './retry'
import {
  getStep,
  guardedTransition,
  claimStep,
  lookupCompletedKey,
  readCheckpoint,
  saveCheckpoint,
  type JobStepName,
  type JobStepRow,
} from './steps'

/**
 * main §14.3 — "the queue delivers **at-least-once**; every worker must
 * therefore be **effectively-once** through its own idempotency mechanics."
 *
 * This is the one place those mechanics live, so no step handler has to
 * re-implement them. In order (constitution invariant 18):
 *
 *   1. serialise on the account's advisory lock (§14.3.3)
 *   2. consult the completed-key ledger; a hit returns the stored output and
 *      does not execute (§14.3.2)
 *   3. claim the step with a guarded transition; a zero-row guard stops (§14.3.1)
 *   4. run the handler with a checkpoint API (§14.3.4)
 *   5. succeed, or classify the failure and either schedule a retry on the
 *      §14.3.5 schedule or dead-letter it
 */

export interface StepContext<C = unknown> {
  readonly db: Db
  readonly accountId: string
  readonly jobId: string
  readonly stepId: string
  readonly step: JobStepName
  readonly idempotencyKey: string
  readonly attempt: number
  /** The last committed cursor, or undefined on a first run (§14.3.4). */
  readonly checkpoint: C | undefined
  /** Commits progress on its own so a crash resumes here, not at the start. */
  save(checkpoint: C): Promise<void>
  /** Aborted on graceful shutdown (tech §2.1). Long loops should check it. */
  readonly signal: AbortSignal
}

export type StepOutcome =
  | { status: 'succeeded'; output: unknown; executed: boolean }
  | { status: 'skipped' }
  | { status: 'not_claimed' }
  | { status: 'retry_scheduled'; nextAttemptAt: Date; errorClass: string }
  | { status: 'dead_lettered'; errorClass: string }
  | { status: 'awaiting_reauth'; provider: 'shopify' | 'gsc' }

export interface RunStepOptions<C> {
  db: Db
  pool: pg.Pool
  accountId: string
  jobId: string
  stepId: string
  /** Derived from inputs, never random (§14.3.2). */
  idempotencyKey: string
  handler: (ctx: StepContext<C>) => Promise<unknown>
  signal?: AbortSignal
  now?: () => Date
  random?: () => number
}

export async function runStep<C = unknown>(options: RunStepOptions<C>): Promise<StepOutcome> {
  const { db, pool, accountId, jobId, stepId, idempotencyKey, handler } = options
  const now = options.now ?? (() => new Date())

  return withAccountLock(pool, accountId, async () => {
    // §14.3.2 — the cache is the ledger. A completed key returns its stored
    // output without executing, which is what makes a retry of finished work
    // free rather than merely safe.
    const completed = await lookupCompletedKey(db, idempotencyKey)
    if (completed) {
      await guardedTransition(db, stepId, ['pending', 'running', 'failed_retryable'], 'succeeded', {
        idempotencyKey,
        outputRef: completed.outputRef as never,
      })
      return { status: 'succeeded', output: completed.outputRef, executed: false }
    }

    // §14.3.1 — guarded claim. Zero rows means someone else owns the step.
    const claimed = await claimStep(db, stepId, idempotencyKey)
    if (!claimed) return { status: 'not_claimed' }

    const checkpoint = await readCheckpoint<C>(db, stepId)

    const controller = new AbortController()
    if (options.signal) {
      if (options.signal.aborted) controller.abort()
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    const ctx: StepContext<C> = {
      db,
      accountId,
      jobId,
      stepId,
      step: claimed.step,
      idempotencyKey,
      attempt: claimed.attempts,
      checkpoint,
      save: (value) => saveCheckpoint(db, stepId, value),
      signal: controller.signal,
    }

    try {
      const output = await handler(ctx)
      const settled = await guardedTransition(db, stepId, 'running', 'succeeded', {
        outputRef: (output ?? null) as never,
        lastError: null,
      })
      // Losing this guard means the step was reassigned mid-flight. The work is
      // done and the ledger records it; report the outcome rather than failing.
      return { status: 'succeeded', output, executed: settled !== undefined }
    } catch (error) {
      return settleFailure({ ...options, claimed, error, now })
    }
  })
}

async function settleFailure<C>(
  args: RunStepOptions<C> & { claimed: JobStepRow; error: unknown; now: () => Date },
): Promise<StepOutcome> {
  const { db, accountId, jobId, stepId, idempotencyKey, claimed, error, now } = args
  const { retryable, errorClass, message } = classify(error)

  // §14.3.5 / §6.2 — token errors route to awaiting_shopify_auth, not the DLQ.
  if (error instanceof TokenInvalidFailure) {
    await guardedTransition(db, stepId, 'running', 'failed_terminal', { lastError: message })
    return { status: 'awaiting_reauth', provider: error.provider }
  }

  if (retryable && !retriesExhausted(claimed.attempts)) {
    const at = nextAttemptAt(claimed.attempts, now(), args.random)!
    await guardedTransition(db, stepId, 'running', 'failed_retryable', {
      lastError: message,
      nextAttemptAt: at,
    })
    return { status: 'retry_scheduled', nextAttemptAt: at, errorClass }
  }

  await guardedTransition(db, stepId, 'running', 'failed_terminal', { lastError: message })

  const step = await getStep(db, stepId)
  await deadLetter(db, {
    accountId,
    jobId,
    stepId,
    step: claimed.step,
    idempotencyKey,
    errorClass,
    lastError: message,
    attempts: claimed.attempts,
    inputRefs: {
      checkpoint: step?.checkpoint ?? null,
      startedAt: step?.startedAt ?? null,
      firstAttemptAt: claimed.startedAt ?? null,
    },
    firstFailedAt: now(),
  })
  return { status: 'dead_lettered', errorClass }
}

import type pg from 'pg'
import type { Db } from '@sortiva/db'
import type { Logger } from '@sortiva/core'
import { deadLetter } from './dlq'
import { classify, StepOwnershipLost, TokenInvalidFailure } from './errors'
import { leaseExpiryFor } from './lease'
import { withAccountLock } from './lock'
import { nextAttemptAt, retriesExhausted } from './retry'
import { runtimeLogger, stepLogger } from './logging'
import { shutdownSignal } from './shutdown'
import {
  getStep,
  guardedTransition,
  claimStep,
  isReclaimable,
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
  /**
   * Already stamped with this store's account id, the job, the step and the
   * attempt — so a handler logging a vendor call needs no mechanism of its own
   * and cannot forget to say which store it is talking about.
   *
   * Identifiers, states, durations, counts and error classes only. Never a
   * product title, body, prompt or draft: main §14.7's privacy note ("ids and
   * aggregates only — never product content, article text, prompts, or anything
   * customer-derived") applies to logs exactly as it does to events.
   */
  readonly log: Logger
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
  /**
   * Defaults to the process shutdown signal (`shutdown.ts`), so a long step
   * gets told about a deploy without every caller having to remember to wire it.
   */
  signal?: AbortSignal
  /** Test/chaos override of the per-step lease in `lease.ts`. Production passes nothing. */
  leaseMs?: number | null
  /** Defaults to the process runtime logger (`logging.ts`). */
  logger?: Logger
  now?: () => Date
  random?: () => number
}

export async function runStep<C = unknown>(options: RunStepOptions<C>): Promise<StepOutcome> {
  const { db, pool, accountId, jobId, stepId, idempotencyKey, handler } = options
  const now = options.now ?? (() => new Date())
  const baseLog = options.logger ?? runtimeLogger()

  return withAccountLock(pool, accountId, async () => {
    // Read first, so every line below can name the step and so the lease check
    // has the step's own budget (`lease.ts`) rather than a default.
    const existing = await getStep(db, stepId)
    const fields = {
      account_id: accountId,
      job_id: jobId,
      step_id: stepId,
      step: existing?.step ?? 'unknown',
      attempt: existing?.attempts ?? 0,
      idempotency_key: idempotencyKey,
    }

    // §14.3.2 — the cache is the ledger. A completed key returns its stored
    // output without executing, which is what makes a retry of finished work
    // free rather than merely safe.
    const completed = await lookupCompletedKey(db, idempotencyKey)
    if (completed) {
      await guardedTransition(db, stepId, ['pending', 'running', 'failed_retryable'], 'succeeded', {
        idempotencyKey,
        outputRef: completed.outputRef as never,
      })
      stepLogger(baseLog, fields).info('step.ledger_hit', { outcome: 'succeeded', executed: false })
      return { status: 'succeeded', output: completed.outputRef, executed: false }
    }

    // Is this a step whose worker died mid-flight? A `running` row past its
    // lease is reclaimable; the per-account lock we are holding is what makes
    // reclaiming safe (§14.3.3).
    const expired = existing ? isReclaimable(existing, now(), options.leaseMs) : false

    // A step that has burnt the §14.3.5 attempt budget by being killed over and
    // over is not reclaimed again — that would be an invisible crash loop. It
    // dead-letters, which is the operator's signal (DLQ depth alerts, §14.7).
    if (expired && existing && retriesExhausted(existing.attempts)) {
      await guardedTransition(db, stepId, 'running', 'failed_terminal', {
        lastError: 'the worker running this step died and did not come back',
      })
      await deadLetter(db, {
        accountId,
        jobId,
        stepId,
        step: existing.step,
        idempotencyKey,
        errorClass: 'lease_expired',
        lastError: `step was abandoned in "running" ${existing.attempts} times; its lease expired with no worker`,
        attempts: existing.attempts,
        inputRefs: { checkpoint: existing.checkpoint ?? null, startedAt: existing.startedAt ?? null },
        firstFailedAt: now(),
      })
      stepLogger(baseLog, fields).error('step.dead_lettered', {
        error_class: 'lease_expired',
        stranded_ms: existing.startedAt ? now().getTime() - existing.startedAt.getTime() : null,
      })
      return { status: 'dead_lettered', errorClass: 'lease_expired' }
    }

    // §14.3.1 — guarded claim. Zero rows means someone else owns the step.
    const claimed = await claimStep(db, stepId, idempotencyKey, {
      expiredBefore: expired && existing ? leaseExpiryFor(existing.step, now(), options.leaseMs) : null,
    })
    if (!claimed) {
      stepLogger(baseLog, fields).info('step.not_claimed', {
        reason: 'guard matched no rows; another worker owns this step',
      })
      return { status: 'not_claimed' }
    }

    const log = stepLogger(baseLog, {
      ...fields,
      step: claimed.step,
      attempt: claimed.attempts,
    })

    if (expired && existing?.startedAt) {
      // The line that explains a stall nobody else can see: this step was left
      // in `running` by a process that died, and how long it sat there.
      log.warn('step.reclaimed', {
        stranded_ms: now().getTime() - existing.startedAt.getTime(),
        stranded_since: existing.startedAt.toISOString(),
      })
    }

    const checkpoint = await readCheckpoint<C>(db, stepId)

    const controller = new AbortController()
    // The shutdown signal outlives every step, so the bridge is removed when
    // this step ends — otherwise a long-running process accumulates one dead
    // listener per step executed.
    const source = options.signal ?? shutdownSignal()
    const forward = () => controller.abort(source.reason)
    if (source.aborted) forward()
    else source.addEventListener('abort', forward, { once: true })

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
      log,
    }

    log.info('step.claimed', { resumed_from_checkpoint: checkpoint !== undefined })
    const startedAt = now().getTime()

    try {
      const output = await handler(ctx)
      const settled = await guardedTransition(db, stepId, 'running', 'succeeded', {
        outputRef: (output ?? null) as never,
        lastError: null,
      })
      // Losing this guard means the step was reassigned mid-flight. The work is
      // done and the ledger records it; report the outcome rather than failing.
      log.info('step.succeeded', {
        duration_ms: now().getTime() - startedAt,
        // False when the step finished but another worker had already taken the
        // row — worth seeing, because it means a lease expired too early.
        owned_at_finish: settled !== undefined,
      })
      return { status: 'succeeded', output, executed: settled !== undefined }
    } catch (error) {
      // §14.3.1 — "a worker whose guard matches zero rows stops immediately".
      // The step now belongs to someone else; touching the row further would be
      // exactly the interference the guard exists to prevent.
      if (error instanceof StepOwnershipLost) {
        log.warn('step.ownership_lost', { duration_ms: now().getTime() - startedAt })
        return { status: 'not_claimed' }
      }
      return settleFailure({ ...options, claimed, error, now, log, startedAt })
    } finally {
      source.removeEventListener('abort', forward)
    }
  })
}

async function settleFailure<C>(
  args: RunStepOptions<C> & {
    claimed: JobStepRow
    error: unknown
    now: () => Date
    log: Logger
    startedAt: number
  },
): Promise<StepOutcome> {
  const { db, accountId, jobId, stepId, idempotencyKey, claimed, error, now, log } = args
  const { retryable, errorClass, message } = classify(error)
  const duration_ms = now().getTime() - args.startedAt
  // The stack is the half that was missing: a bare message says a step failed,
  // a stack says where. Both go through the scrubber, so a token embedded in
  // either is redacted before it reaches the sink (tech §4).
  const stack = error instanceof Error ? error.stack : undefined

  // §14.3.5 / §6.2 — token errors route to awaiting_shopify_auth, not the DLQ.
  if (error instanceof TokenInvalidFailure) {
    await guardedTransition(db, stepId, 'running', 'failed_terminal', { lastError: message })
    log.warn('step.awaiting_reauth', {
      duration_ms,
      provider: error.provider,
      error_class: errorClass,
      error: message,
    })
    return { status: 'awaiting_reauth', provider: error.provider }
  }

  if (retryable && !retriesExhausted(claimed.attempts)) {
    const at = nextAttemptAt(claimed.attempts, now(), args.random)!
    await guardedTransition(db, stepId, 'running', 'failed_retryable', {
      lastError: message,
      nextAttemptAt: at,
    })
    log.warn('step.failed', {
      duration_ms,
      error_class: errorClass,
      error: message,
      stack,
      will_retry: true,
      next_attempt_at: at.toISOString(),
    })
    return { status: 'retry_scheduled', nextAttemptAt: at, errorClass }
  }

  await guardedTransition(db, stepId, 'running', 'failed_terminal', { lastError: message })
  log.error('step.failed', {
    duration_ms,
    error_class: errorClass,
    error: message,
    stack,
    will_retry: false,
    reason: retryable ? 'retries exhausted' : 'terminal failure class',
  })

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
  log.error('step.dead_lettered', { error_class: errorClass, attempts: claimed.attempts })
  return { status: 'dead_lettered', errorClass }
}

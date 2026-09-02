import { sql } from 'drizzle-orm'
import {
  sendQueuedEmail,
  type EmailProvider,
  type EmailRenderer,
  type EmailSendDeps,
  type Logger,
} from '@sortiva/core'
import { makeEmailStore, systemScope, type Db } from '@sortiva/db'
import type pg from 'pg'
import { deadLetter } from '../runtime/dlq'
import { withAccountLock } from '../runtime/lock'
import { runtimeLogger } from '../runtime/logging'
import { MAX_ATTEMPTS, nextAttemptAt } from '../runtime/retry'
import { registerTask } from '../runtime/tasks'
import { makeEmailAssembler, type AssemblerDeps } from './assembler'

/**
 * Getting queued mail out of the door, in two halves.
 *
 * A sweep every minute turns each queued row into its own job; the job sends
 * one email. Splitting it that way is what gives each email its own retry
 * budget — one address the vendor keeps rejecting cannot hold up everybody
 * else's mail behind it, and a failure that has run out of attempts
 * dead-letters on its own rather than taking a batch with it.
 *
 * The job is filed under a key derived from the row, so a sweep firing while a
 * retry is still pending lands on the existing job rather than stacking a
 * second one on top of it — and `preserve_run_at` means it does not drag that
 * retry forward to now, which would defeat the backoff.
 */

export const EMAIL_SEND_TASK = 'email_send'
export const EMAIL_SEND_DRAIN_TASK = 'email_send_drain'

/** How many rows one sweep turns into jobs. A bound, not a target. */
const DRAIN_BATCH = 200

export interface EmailSendPayload {
  readonly emailSendId: string
  /** 1 on the first attempt. Carried in the payload because a retry is a new job. */
  readonly attempt?: number
}

export interface EmailWorkerDeps {
  readonly getDb: () => Db
  readonly getPool: () => pg.Pool
  readonly provider: EmailProvider
  readonly renderer: EmailRenderer
  /**
   * The database handle is deliberately not among these: it comes from `getDb`
   * above, so a worker cannot end up assembling an email from one database and
   * settling its row in another.
   */
  readonly assembler?: Omit<AssemblerDeps, 'getDb'>
  readonly logger?: Logger
  readonly now?: () => Date
  readonly random?: () => number
}

function sendDeps(deps: EmailWorkerDeps): EmailSendDeps {
  return {
    store: makeEmailStore({ database: deps.getDb() }),
    assembler: makeEmailAssembler({ getDb: deps.getDb, ...(deps.assembler ?? {}) }),
    renderer: deps.renderer,
    provider: deps.provider,
  }
}

export async function enqueueEmailSend(
  database: Db,
  payload: EmailSendPayload,
  runAt?: Date,
): Promise<void> {
  const body = JSON.stringify({ emailSendId: payload.emailSendId, attempt: payload.attempt ?? 1 })
  const key = `${EMAIL_SEND_TASK}:${payload.emailSendId}`
  const at = runAt ? runAt.toISOString() : null
  await database.execute(
    sql`select graphile_worker.add_job(
      ${EMAIL_SEND_TASK},
      payload := ${body}::json,
      job_key := ${key},
      job_key_mode := 'preserve_run_at',
      run_at := ${at}::timestamptz
    )`,
  )
}

export interface DrainResult {
  readonly queued: number
}

/** One sweep: every queued row gets a job, and a row that already has one keeps it. */
export async function drainEmailQueue(deps: EmailWorkerDeps): Promise<DrainResult> {
  const db = deps.getDb()
  const log = deps.logger ?? runtimeLogger()
  const rows = await makeEmailStore({ database: db }).listQueued(DRAIN_BATCH)
  for (const row of rows) await enqueueEmailSend(db, { emailSendId: row.id })
  log.info('email_send_drain.completed', { queued: rows.length })
  return { queued: rows.length }
}

export type SendJobResult =
  | { readonly status: 'sent' }
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'retry_scheduled'; readonly at: Date }
  | { readonly status: 'dead_lettered'; readonly errorClass: string }

/**
 * One email. Runs under the account's lock, so two workers handed the same row
 * — which an at-least-once queue permits — serialise, and the second finds the
 * row already settled instead of sending a duplicate.
 */
export async function runEmailSend(
  deps: EmailWorkerDeps,
  payload: EmailSendPayload,
): Promise<SendJobResult> {
  const db = deps.getDb()
  const log = deps.logger ?? runtimeLogger()
  const now = deps.now ?? (() => new Date())
  const attempt = payload.attempt ?? 1

  const store = makeEmailStore({ database: db })
  const record = await store.get(payload.emailSendId)
  if (!record) return { status: 'skipped', reason: 'gone' }

  return withAccountLock(deps.getPool(), record.accountId, async () => {
    const outcome = await sendQueuedEmail(sendDeps(deps), payload.emailSendId, {
      attempt,
      maxAttempts: MAX_ATTEMPTS,
    })

    switch (outcome.status) {
      case 'sent':
        log.info('email_send.sent', { type: record.type, attempt })
        return { status: 'sent' }

      case 'already_settled':
      case 'suppressed':
      case 'abandoned':
        log.info('email_send.skipped', { type: record.type, outcome: outcome.status })
        return { status: 'skipped', reason: outcome.status }

      case 'retry': {
        const at = nextAttemptAt(attempt, now(), deps.random) ?? now()
        await enqueueEmailSend(db, { emailSendId: payload.emailSendId, attempt: outcome.attempt }, at)
        log.info('email_send.retry_scheduled', {
          type: record.type,
          attempt,
          error_class: outcome.errorClass,
        })
        return { status: 'retry_scheduled', at }
      }

      case 'dead_letter':
        await deadLetter(db, {
          accountId: record.accountId,
          step: EMAIL_SEND_TASK,
          // Derived from the row, not generated: a replay of this entry has to
          // arrive at the same key or the send would go out twice.
          idempotencyKey: `${record.accountId}:${record.type}:${record.dedupeKey}`,
          errorClass: outcome.errorClass,
          lastError: outcome.lastError,
          attempts: outcome.attempts,
          inputRefs: { email_send_id: payload.emailSendId, type: record.type },
          firstFailedAt: now(),
        })
        log.error('email_send.dead_lettered', {
          type: record.type,
          error_class: outcome.errorClass,
        })
        return { status: 'dead_lettered', errorClass: outcome.errorClass }
    }
  })
}

let registered = false

export function registerEmailTasks(deps: EmailWorkerDeps): void {
  if (registered) return
  registered = true

  registerTask(EMAIL_SEND_DRAIN_TASK, async () => {
    await drainEmailQueue(deps)
  })

  registerTask(EMAIL_SEND_TASK, async (rawPayload) => {
    const payload = rawPayload as EmailSendPayload
    if (!payload?.emailSendId) throw new Error('email_send needs an emailSendId')
    await runEmailSend(deps, payload)
  })
}

/** Test-only: the task registry is a module singleton, and so is this latch. */
export function resetEmailTaskRegistration(): void {
  registered = false
}

/** Exposed so the retention sweep and the diagnostics script can reach the same reads. */
export const emailSystemScope = () =>
  systemScope('the send worker drains queued mail for every account')

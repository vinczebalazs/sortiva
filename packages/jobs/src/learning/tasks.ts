import { sql } from 'drizzle-orm'
import type pg from 'pg'
import { localClock, type Logger, type PosthogCapture } from '@sortiva/core'
import {
  accountScope,
  accountsReadyForPlanning,
  readAccountSettings,
  systemScope,
  type Db,
} from '@sortiva/db'
import { registerTask } from '../runtime/tasks'
import { runtimeLogger } from '../runtime/logging'
import { recomputeLearningForAccount } from './recompute'

/**
 * The weekly learning run: a sweep that asks every planning store to be looked
 * at, and one job per store that does the looking.
 *
 * **Why a job per store rather than a loop**, the same reason the generation
 * cycle and the calendar top-up are shaped this way: one store's failure should
 * be one store's failure, and the queue's retry should apply to it alone rather
 * than restarting a pass over every account. It also means each store's work
 * takes that store's lock and nothing else's, which a single looping job could
 * not honestly declare.
 *
 * The sweep decides nothing. Whether there is anything to judge is a read of
 * the store's own search history, made inside the lock by the job, so a sweep
 * that runs twice costs a read and changes nothing.
 */

export const LEARNING_RECOMPUTE_SWEEP_TASK = 'learning_recompute_weekly'
export const LEARNING_RECOMPUTE_ACCOUNT_TASK = 'learning_recompute_account'

export interface LearningRecomputeAccountPayload {
  readonly accountId: string
  /** The store's own calendar date this job was queued for — part of the job key, so one local day queues one job. */
  readonly date: string
}

export interface LearningTaskDeps {
  /** Factories rather than handles, so registering at process start opens no connection. */
  readonly getDb: () => Db
  readonly getPool: () => pg.Pool
  readonly capture?: Pick<PosthogCapture, 'capture'>
  readonly now?: () => Date
  readonly logger?: Logger
}

export async function enqueueLearningRecompute(
  db: Db,
  payload: LearningRecomputeAccountPayload,
): Promise<void> {
  const body = JSON.stringify(payload)
  const key = `${LEARNING_RECOMPUTE_ACCOUNT_TASK}:${payload.accountId}:${payload.date}`
  await db.execute(
    sql`select graphile_worker.add_job(${LEARNING_RECOMPUTE_ACCOUNT_TASK}, payload := ${body}::json, job_key := ${key}, job_key_mode := 'preserve_run_at')`,
  )
}

export async function sweepLearningRecomputes(
  deps: LearningTaskDeps,
): Promise<{ readonly considered: number; readonly queued: number }> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const db = deps.getDb()

  const accountIds = await accountsReadyForPlanning(
    db,
    systemScope('the weekly learning run looks across every planning account for articles to judge'),
  )

  for (const accountId of accountIds) {
    const settings = await readAccountSettings(db, accountScope(accountId))
    // The store's own date, so a job key is one per store per local day rather
    // than per UTC day — the same shape every other per-account sweep uses.
    await enqueueLearningRecompute(db, { accountId, date: localClock(now, settings.timezone).date })
  }

  log.info('learning_recompute_sweep_complete', {
    considered: accountIds.length,
    queued: accountIds.length,
  })
  return { considered: accountIds.length, queued: accountIds.length }
}

let registered = false

export function registerLearningTasks(deps: LearningTaskDeps): void {
  if (registered) return
  registered = true

  // `fans_out`: the sweep touches no single account's derived data — it reads
  // the list of planning accounts and queues one job each. The runtime cannot
  // check this class and says so; what holds it is that the work it fans out to
  // is itself declared per account, below.
  registerTask(
    LEARNING_RECOMPUTE_SWEEP_TASK,
    async () => {
      await sweepLearningRecomputes(deps)
    },
    'fans_out',
  )

  // `per_account`: the account is named in the payload, and everything the job
  // writes — one store's verdicts, one store's learned picture — is that
  // store's derived data. The runtime fails the job if it finishes without
  // having asked for that account's lock, which `recomputeLearningForAccount`
  // takes around the whole pass.
  registerTask(
    LEARNING_RECOMPUTE_ACCOUNT_TASK,
    async (payload) => {
      const { accountId } = payload as LearningRecomputeAccountPayload
      if (typeof accountId !== 'string' || accountId === '') {
        throw new Error('learning_recompute_account was queued without an accountId')
      }
      await recomputeLearningForAccount(
        {
          db: deps.getDb(),
          pool: deps.getPool(),
          ...(deps.capture ? { capture: deps.capture } : {}),
          ...(deps.now ? { now: deps.now } : {}),
          ...(deps.logger ? { logger: deps.logger } : {}),
        },
        accountId,
      )
    },
    'per_account',
  )
}

/** Test-only: the task registry is a module singleton, and so is this latch. */
export function resetLearningTaskRegistration(): void {
  registered = false
}

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { jobSteps } from '@sortiva/db'
import { silentLogger } from '@sortiva/core'
import {
  TEST_DATABASE_URL,
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { setRuntimeLogger } from '../runtime/logging'
import { createRun, findStep } from '../runtime/steps'
import { deriveIdempotencyKey } from '../runtime/idempotency'
import { runStep } from '../runtime/runStep'
import { TRUNCATE_QUEUE_SQL, installQueueSchema, type WorkerUtils } from '../runtime/testing'
import { sweepStalledIngestionRuns } from './retry-sweep'

/**
 * A store whose onboarding stopped and asked to be tried again gets tried
 * again, with nobody touching it.
 *
 * Written from outside the sweep on purpose. The defect was never that a
 * function computed the wrong backoff — the backoff was right, it was written
 * to the row, and nothing ever read it. So what is asserted here is that a real
 * step, failed the way a flaky vendor read fails it, ends up with a real job in
 * a real queue once its moment arrives.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('coming back for a stalled onboarding run', () => {
  let test: TestDb
  let workerUtils: WorkerUtils
  let accountId: string
  let jobId: string
  let stepId: string

  beforeAll(async () => {
    test = await setupTestDb('ingestion_retry_sweep')
    setRuntimeLogger(silentLogger)
    const url = new URL(TEST_DATABASE_URL)
    url.pathname = `/${test.databaseName}`
    workerUtils = await installQueueSchema(url.toString())
  })

  afterAll(async () => {
    await workerUtils?.release()
    await test.close()
  })

  beforeEach(async () => {
    await truncateAll(test.pool)
    await test.pool.query(TRUNCATE_QUEUE_SQL)
    accountId = await insertAccount(test.pool, `sweep-${Date.now()}-${Math.random()}@sortiva.test`)
    ;({ jobId } = await createRun(test.db, accountId, `sweep:${accountId}`))
    stepId = (await findStep(test.db, jobId, 'detect'))!.id
  })

  /** Fails the first step the way a timeout or a 502 fails it: retryable, with a time to come back. */
  async function failRetryably(): Promise<Date> {
    const outcome = await runStep({
      db: test.db,
      pool: test.pool,
      accountId,
      jobId,
      stepId,
      idempotencyKey: deriveIdempotencyKey(accountId, 'detect', 'v1'),
      handler: async () => {
        throw new Error('the storefront timed out')
      },
    })
    expect(outcome.status).toBe('retry_scheduled')
    return (outcome as { nextAttemptAt: Date }).nextAttemptAt
  }

  async function queuedDispatches(): Promise<number> {
    const { rows } = await test.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM graphile_worker.jobs
        WHERE task_identifier = 'ingestion_dispatch' AND key = $1`,
      [`ingestion_dispatch:${accountId}`],
    )
    return Number(rows[0]!.n)
  }

  it('queues nothing while the backoff is still running', async () => {
    const due = await failRetryably()

    const before = new Date(due.getTime() - 1000)
    expect(await sweepStalledIngestionRuns({ getDb: () => test.db, now: () => before })).toEqual({
      due: 0,
      queued: 0,
    })
    expect(await queuedDispatches()).toBe(0)
  })

  it('queues the run once its next attempt is due', async () => {
    const due = await failRetryably()

    const after = new Date(due.getTime() + 1000)
    expect(await sweepStalledIngestionRuns({ getDb: () => test.db, now: () => after })).toEqual({
      due: 1,
      queued: 1,
    })
    expect(await queuedDispatches()).toBe(1)
  })

  it('leaves one job behind rather than a job per sweep', async () => {
    const due = await failRetryably()
    const after = new Date(due.getTime() + 1000)

    await sweepStalledIngestionRuns({ getDb: () => test.db, now: () => after })
    await sweepStalledIngestionRuns({ getDb: () => test.db, now: () => after })
    await sweepStalledIngestionRuns({ getDb: () => test.db, now: () => after })

    // The job key is the account, so a store that is already queued keeps the
    // one job it has. Without that, a store whose worker is busy would collect
    // a job every five minutes for as long as it stayed stalled.
    expect(await queuedDispatches()).toBe(1)
  })

  /**
   * The case the sweep must not touch. `oauth_wait` sits pending for as long as
   * the merchant takes to press Approve, which can be days; queueing a job for
   * it every five minutes would be work that cannot accomplish anything.
   */
  it('ignores a run that is waiting for the merchant rather than for a clock', async () => {
    await test.db
      .update(jobSteps)
      .set({ state: 'succeeded' })
      .where(eq(jobSteps.id, stepId))

    expect(await sweepStalledIngestionRuns({ getDb: () => test.db })).toEqual({ due: 0, queued: 0 })
    expect(await queuedDispatches()).toBe(0)
  })

  it('ignores a step that failed for good, which no clock will fix', async () => {
    await test.db
      .update(jobSteps)
      .set({ state: 'failed_terminal', nextAttemptAt: new Date(0) })
      .where(eq(jobSteps.id, stepId))

    expect(await sweepStalledIngestionRuns({ getDb: () => test.db })).toEqual({ due: 0, queued: 0 })
  })
})

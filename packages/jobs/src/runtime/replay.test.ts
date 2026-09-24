import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { jobDlq, jobSteps } from '@sortiva/db'
import { silentLogger } from '@sortiva/core'
import {
  TEST_DATABASE_URL,
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { TRUNCATE_QUEUE_SQL, installQueueSchema, type WorkerUtils } from './testing'
import { setRuntimeLogger } from './logging'
import { createRun, findStep, getStep } from './steps'
import { deriveIdempotencyKey } from './idempotency'
import { listOpenDlq, replayDlqEntry } from './dlq'
import { runStep } from './runStep'
import { TerminalFailure } from './errors'

/**
 * T-OPS: one action replays permanently-failed work, and the replay re-runs the
 * work rather than doing it twice.
 *
 * Both halves are proved end to end against a real database: a step is made to
 * fail for good, replayed, run again — and then handed to the runner a third
 * time to show that finished work is recognised and skipped rather than
 * repeated.
 *
 * The real queue is installed here rather than stubbed, because the defect this
 * suite now also guards is that the replay left the step pending and asked
 * nobody to run it. "The work was queued" is a claim about a row in the queue,
 * so the queue has to be real for the assertion to mean anything.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('replaying a dead-lettered step', () => {
  let test: TestDb
  let workerUtils: WorkerUtils
  let accountId: string
  let jobId: string
  let stepId: string
  let key: string

  beforeAll(async () => {
    test = await setupTestDb('tops_replay')
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
    accountId = await insertAccount(test.pool, `replay-${Date.now()}-${Math.random()}@sortiva.test`)
    ;({ jobId } = await createRun(test.db, accountId, `replay:${accountId}`))
    stepId = (await findStep(test.db, jobId, 'detect'))!.id
    key = deriveIdempotencyKey(accountId, 'detect', 'v1')
  })

  const run = (handler: () => Promise<unknown>) =>
    runStep({ db: test.db, pool: test.pool, accountId, jobId, stepId, idempotencyKey: key, handler })

  /** How many onboarding dispatches are sitting in the real queue for this account. */
  async function queuedDispatches(): Promise<number> {
    // The queue's own view exposes the job key but not the payload, and the key
    // is the account by construction — see `enqueueIngestionDispatch`.
    const { rows } = await test.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM graphile_worker.jobs
        WHERE task_identifier = 'ingestion_dispatch' AND key = $1`,
      [`ingestion_dispatch:${accountId}`],
    )
    return Number(rows[0]!.n)
  }

  it('puts the step back on the queue, re-runs the work, and refuses to run it twice', async () => {
    let executions = 0

    // 1. The step fails for good and dead-letters.
    const first = await run(async () => {
      executions += 1
      throw new TerminalFailure('storefront_unreadable', 'the storefront returned malformed JSON')
    })
    expect(first.status).toBe('dead_lettered')
    expect(executions).toBe(1)
    expect((await getStep(test.db, stepId))!.state).toBe('failed_terminal')

    // 2. One action — the same call `pnpm dlq replay` makes.
    const [entry] = await listOpenDlq(test.db)
    expect(entry).toBeDefined()
    const outcome = await replayDlqEntry(test.db, entry!.id, 'operator')
    expect(outcome.status).toBe('replayed')
    expect((await getStep(test.db, stepId))!.state).toBe('pending')

    // And somebody was actually asked to run it. Returning the step to pending
    // used to be the whole of a replay: the operator was told the work was
    // queued and no job existed, so the step waited for a dispatch that only a
    // merchant's own next action would have caused.
    expect(await queuedDispatches()).toBe(1)

    // 3. The work really runs again — the failure is retried, not skipped.
    const second = await run(async () => {
      executions += 1
      return { products: 42 }
    })
    expect(second.status).toBe('succeeded')
    expect(second.status === 'succeeded' && second.executed).toBe(true)
    expect(executions).toBe(2)

    // 4. Handed to the runner once more, it recognises finished work and does
    //    not do it again — which is why replaying is safe in the first place.
    const third = await run(async () => {
      executions += 1
      return { products: 999 }
    })
    expect(third.status).toBe('succeeded')
    expect(third.status === 'succeeded' && third.executed).toBe(false)
    expect(third.status === 'succeeded' && third.output).toEqual({ products: 42 })
    expect(executions).toBe(2)
  })

  it('a second replay of the same entry does nothing, rather than queueing it twice', async () => {
    await run(async () => {
      throw new TerminalFailure('storefront_unreadable', 'the storefront returned malformed JSON')
    })
    const [entry] = await listOpenDlq(test.db)

    expect((await replayDlqEntry(test.db, entry!.id, 'operator')).status).toBe('replayed')

    // Somebody else runs the command a moment later.
    await test.db.update(jobSteps).set({ state: 'running' }).where(eq(jobSteps.id, stepId))
    expect((await replayDlqEntry(test.db, entry!.id, 'operator')).status).toBe('already_replayed')
    expect((await getStep(test.db, stepId))!.state).toBe('running')
  })

  it('reports rather than pretends when the entry has no step to reschedule', async () => {
    const [row] = await test.db
      .insert(jobDlq)
      .values({
        accountId,
        step: 'publish',
        idempotencyKey: 'publish-key',
        errorClass: 'upstream_5xx',
        lastError: 'Shopify refused the create three times',
        attempts: 3,
        firstFailedAt: new Date(),
      })
      .returning()

    const outcome = await replayDlqEntry(test.db, row!.id, 'operator')
    expect(outcome.status).toBe('step_missing')
  })
})

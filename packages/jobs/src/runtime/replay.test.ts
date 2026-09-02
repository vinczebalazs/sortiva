import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { jobDlq, jobSteps } from '@sortiva/db'
import { silentLogger } from '@sortiva/core'
import {
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
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
 */

const available = await databaseAvailable()

describe.skipIf(!available)('replaying a dead-lettered step', () => {
  let test: TestDb
  let accountId: string
  let jobId: string
  let stepId: string
  let key: string

  beforeAll(async () => {
    test = await setupTestDb('tops_replay')
    setRuntimeLogger(silentLogger)
  })

  afterAll(async () => {
    await test.close()
  })

  beforeEach(async () => {
    await truncateAll(test.pool)
    accountId = await insertAccount(test.pool, `replay-${Date.now()}-${Math.random()}@sortiva.test`)
    ;({ jobId } = await createRun(test.db, accountId, `replay:${accountId}`))
    stepId = (await findStep(test.db, jobId, 'detect'))!.id
    key = deriveIdempotencyKey(accountId, 'detect', 'v1')
  })

  const run = (handler: () => Promise<unknown>) =>
    runStep({ db: test.db, pool: test.pool, accountId, jobId, stepId, idempotencyKey: key, handler })

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

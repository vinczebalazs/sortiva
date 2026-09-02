import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MockPosthogCapture } from '@sortiva/providers'
import { initAppServices, resetAppServices } from '@sortiva/core/runtime/services'
import { setRuntimeLogger } from './logging'
import { silentLogger } from '@sortiva/core'
import {
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { createRun, findStep } from './steps'
import { deriveIdempotencyKey } from './idempotency'
import { runStep } from './runStep'
import { TerminalFailure } from './errors'

/**
 * T-OPS: an error in a job step that nobody is going to handle reaches the
 * crash reporter.
 *
 * Driven through the real step runner against a real database, so what is
 * asserted is the call a genuinely failing step makes — not that a line of
 * wiring exists.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('a step that fails for good', () => {
  let test: TestDb
  let analytics: MockPosthogCapture

  beforeAll(async () => {
    test = await setupTestDb('tops_step_crash')
    setRuntimeLogger(silentLogger)
  })

  afterAll(async () => {
    await test.close()
  })

  beforeEach(async () => {
    await truncateAll(test.pool)
    analytics = new MockPosthogCapture()
    initAppServices(() => ({ analytics }))
  })

  afterEach(() => {
    resetAppServices()
  })

  async function firstStep() {
    const accountId = await insertAccount(test.pool, `crash-${Date.now()}-${Math.random()}@sortiva.test`)
    const { jobId } = await createRun(test.db, accountId, `crash:${accountId}`)
    const step = (await findStep(test.db, jobId, 'detect'))!
    return { accountId, jobId, step }
  }

  it('is captured, named by step and error class, attributed to the store', async () => {
    const { accountId, jobId, step } = await firstStep()

    const outcome = await runStep({
      db: test.db,
      pool: test.pool,
      accountId,
      jobId,
      stepId: step.id,
      idempotencyKey: deriveIdempotencyKey(accountId, 'detect', 'v1'),
      handler: () => {
        throw new TerminalFailure('schema_invalid', 'the storefront returned malformed JSON')
      },
    })

    expect(outcome.status).toBe('dead_lettered')
    expect(analytics.exceptions).toHaveLength(1)
    const [captured] = analytics.exceptions
    expect((captured!.error as Error).message).toBe('the storefront returned malformed JSON')
    expect(captured!.capture.distinctId).toBe(accountId)
    expect(captured!.capture.properties).toMatchObject({
      source: 'job_step',
      step: 'detect',
      error_class: 'schema_invalid',
    })
  })

  it('is not captured while the step is still going to be retried', async () => {
    const { accountId, jobId, step } = await firstStep()

    const outcome = await runStep({
      db: test.db,
      pool: test.pool,
      accountId,
      jobId,
      stepId: step.id,
      idempotencyKey: deriveIdempotencyKey(accountId, 'detect', 'v1'),
      handler: () => {
        throw new Error('the vendor timed out')
      },
    })

    expect(outcome.status).toBe('retry_scheduled')
    expect(analytics.exceptions).toHaveLength(0)
  })
})

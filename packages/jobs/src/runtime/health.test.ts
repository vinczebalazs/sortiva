import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { UnrecordedCapture } from '@sortiva/providers'
import { TEST_DATABASE_URL, databaseAvailable, setupTestDb, type TestDb } from '@sortiva/db/testing'
import { resetWorkerLiveness, workerLiveness } from '@sortiva/core/observability/health'
import { bootstrapWorker } from './bootstrap'

/**
 * T-OPS: the health check fails when the worker is not running, and this is the
 * half that makes that true — the worker saying, in one process-wide place,
 * whether it is up.
 *
 * Driven through the real `bootstrapWorker` rather than by calling the marker
 * functions, because a marker nobody calls is exactly the false confidence the
 * card exists to remove.
 */

const quiet = { log: () => {}, error: () => {} }
const available = await databaseAvailable()

describe('WORKER_ENABLED=false', () => {
  it('records that no worker belongs here, which the health check reads as well', async () => {
    resetWorkerLiveness()
    const previous = process.env.WORKER_ENABLED
    process.env.WORKER_ENABLED = 'false'
    try {
      const worker = await bootstrapWorker({ analytics: new UnrecordedCapture(), logger: quiet })
      expect(worker).toBeUndefined()
      expect(workerLiveness()).toEqual({ status: 'not_expected', reason: 'WORKER_ENABLED=false' })
    } finally {
      process.env.WORKER_ENABLED = previous
    }
  })
})

describe('a worker that cannot start', () => {
  it('records that it stopped, rather than leaving the health check with nothing to read', async () => {
    resetWorkerLiveness()
    await expect(
      bootstrapWorker({
        analytics: new UnrecordedCapture(),
        connectionString: 'postgres://sortiva:sortiva@127.0.0.1:1/sortiva',
        logger: quiet,
      }),
    ).rejects.toThrow()
    const liveness = workerLiveness()
    expect(liveness.status).toBe('stopped')
    expect(liveness.status === 'stopped' && liveness.reason).toContain('failed to start')
  })
})

describe.skipIf(!available)('a worker that starts and then stops', () => {
  let test: TestDb

  beforeAll(async () => {
    test = await setupTestDb('tops_worker_liveness')
  })

  afterAll(async () => {
    await test.close()
  })

  it('reads as running while it runs, and as stopped once it has drained', async () => {
    resetWorkerLiveness()
    const url = new URL(TEST_DATABASE_URL)
    url.pathname = `/${test.databaseName}`

    const worker = await bootstrapWorker({
      analytics: new UnrecordedCapture(),
      connectionString: url.toString(),
      logger: quiet,
      signals: ['SIGUSR2'],
      exit: () => {},
    })
    expect(worker).toBeDefined()
    expect(workerLiveness().status).toBe('running')

    await worker!.stop()
    // The runner's promise is what reports the stop, and it settles on its own
    // microtask after `stop()` resolves.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(workerLiveness().status).toBe('stopped')
  })
})

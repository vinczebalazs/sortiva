import { afterEach, describe, expect, it } from 'vitest'
import { closeDb } from '@sortiva/db'
import { TEST_DATABASE_URL, databaseAvailable } from '@sortiva/db/testing'
import {
  markWorkerNotExpected,
  markWorkerRunning,
  markWorkerStopped,
  resetWorkerLiveness,
} from '@sortiva/core/observability/health'
import { makeHealthHandler } from './handler'

/**
 * T-OPS: the health check has to be able to fail, and the only way to know it
 * can is to break each thing it checks and watch it fail.
 *
 * The database half is broken for real — the handler built exactly as
 * production builds it, pointed at a port with nothing listening — rather than
 * with a stubbed rejection, because a stub proves the branch and not the
 * wiring. The worker half is driven through the same liveness record the real
 * worker writes.
 */

const answers = () => Promise.resolve(undefined)
const originalDatabaseUrl = process.env.DATABASE_URL

afterEach(async () => {
  resetWorkerLiveness()
  await closeDb()
  process.env.DATABASE_URL = originalDatabaseUrl
})

describe('GET /api/health', () => {
  it('answers 200 with exactly { ok: true } when both halves are well', async () => {
    markWorkerRunning()
    const response = await makeHealthHandler({ pingDatabase: answers })()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('answers 503 naming the worker when the worker is not running', async () => {
    const response = await makeHealthHandler({ pingDatabase: answers })()
    expect(response.status).toBe(503)
    const body = (await response.json()) as {
      error: { code: string; details: { path: string; message: string }[] }
    }
    expect(body.error.code).toBe('unhealthy')
    expect(body.error.details).toEqual([
      { path: 'worker', message: 'the worker never reported starting' },
    ])
  })

  it('answers 503 naming the worker when it started and then stopped', async () => {
    markWorkerRunning()
    markWorkerStopped('the runner exited: connection terminated unexpectedly')
    const response = await makeHealthHandler({ pingDatabase: answers })()
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { details: { path: string }[] } }
    expect(body.error.details.map((d) => d.path)).toEqual(['worker'])
  })

  it('stays healthy on a process that is deliberately worker-free', async () => {
    markWorkerNotExpected('WORKER_ENABLED=false')
    const response = await makeHealthHandler({ pingDatabase: answers })()
    expect(response.status).toBe(200)
  })
})

describe('the production wiring, with the database really broken', () => {
  it('answers 503 when the database is unreachable', async () => {
    markWorkerRunning()
    // Port 1 is privileged and unused, so this is a refused connection rather
    // than a stubbed rejection — and the handler is the one `route.ts` exports,
    // built with no probes of its own.
    process.env.DATABASE_URL = 'postgres://sortiva:sortiva@127.0.0.1:1/sortiva'
    await closeDb()

    const response = await makeHealthHandler()()
    expect(response.status).toBe(503)
    const body = (await response.json()) as {
      error: { details: { path: string; message: string }[] }
    }
    expect(body.error.details[0]!.path).toBe('database')
    expect(body.error.details[0]!.message).toMatch(/ECONNREFUSED|did not answer/)
  })

  it('answers 200 through the same wiring when the database is there', async () => {
    if (!(await databaseAvailable())) return
    markWorkerRunning()
    process.env.DATABASE_URL = TEST_DATABASE_URL
    await closeDb()

    const response = await makeHealthHandler()()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })
})

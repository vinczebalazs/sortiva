import { afterEach, describe, expect, it } from 'vitest'
import {
  checkHealth,
  markWorkerNotExpected,
  markWorkerRunning,
  markWorkerStopped,
  resetWorkerLiveness,
  workerLiveness,
} from './health'

const answers = () => Promise.resolve({ ok: 1 })
const refuses = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:1'))

afterEach(() => {
  resetWorkerLiveness()
})

describe('the health check can fail', () => {
  it('passes only when the database answers and the worker is running', async () => {
    markWorkerRunning()
    const report = await checkHealth({ pingDatabase: answers })
    expect(report.ok).toBe(true)
    expect(report.checks.map((c) => c.name)).toEqual(['database', 'worker'])
  })

  it('fails when the database is unreachable, and says which probe failed', async () => {
    markWorkerRunning()
    const report = await checkHealth({ pingDatabase: refuses })
    expect(report.ok).toBe(false)
    const database = report.checks.find((c) => c.name === 'database')!
    expect(database.ok).toBe(false)
    expect(database.detail).toContain('ECONNREFUSED')
  })

  it('fails when the worker never started', async () => {
    const report = await checkHealth({ pingDatabase: answers })
    expect(report.ok).toBe(false)
    expect(report.checks.find((c) => c.name === 'worker')).toMatchObject({
      ok: false,
      detail: 'the worker never reported starting',
    })
  })

  it('fails when the worker started and then stopped', async () => {
    markWorkerRunning()
    markWorkerStopped('the runner exited: connection terminated unexpectedly')
    const report = await checkHealth({ pingDatabase: answers })
    expect(report.ok).toBe(false)
    expect(report.checks.find((c) => c.name === 'worker')!.detail).toContain('connection terminated')
  })

  it('stays healthy when this process is deliberately not running a worker', async () => {
    markWorkerNotExpected('WORKER_ENABLED=false')
    const report = await checkHealth({ pingDatabase: answers })
    expect(report.ok).toBe(true)
    expect(report.checks.find((c) => c.name === 'worker')!.detail).toContain('WORKER_ENABLED=false')
  })

  it('never puts the connection string in the answer it serves', async () => {
    markWorkerRunning()
    const report = await checkHealth({
      pingDatabase: () => Promise.reject(new Error('password authentication failed for user "sortiva"')),
    })
    expect(JSON.stringify(report)).not.toContain('postgres://')
  })
})

describe('worker liveness survives a second copy of this module', () => {
  it('is held on globalThis, so the reader and the writer share one record', () => {
    markWorkerRunning(new Date('2026-09-02T10:00:00.000Z'))
    const stored = (globalThis as Record<symbol, unknown>)[
      Symbol.for('sortiva.observability.worker-liveness')
    ]
    expect(stored).toEqual({ status: 'running', since: '2026-09-02T10:00:00.000Z' })
    expect(workerLiveness()).toEqual(stored)
  })
})

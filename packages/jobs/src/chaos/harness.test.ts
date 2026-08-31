import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import {
  WorkerKilled,
  assertEveryStepSettled,
  assertNoDoubleBilling,
  runChaosScenario,
  type ChaosScenario,
} from './harness'

/**
 * The harness under test. A chaos harness that does not actually kill anything,
 * or that passes a run which never converged, is worse than no harness — it
 * reports green while proving nothing (main §14.3.9).
 */

let harness: TestDb
let accountId: string

beforeAll(async () => {
  if (!(await databaseAvailable())) {
    throw new Error('Postgres is not reachable. Run `pnpm db:up` before the test suite.')
  }
  harness = await setupTestDb('chaos_harness')
}, 60_000)

afterAll(async () => {
  await harness?.close()
})

beforeEach(async () => {
  await truncateAll(harness.pool)
  accountId = await insertAccount(harness.pool, 'chaos-harness@example.com')
})

/** A driver that appends to a shared ledger, so a re-run's effect is visible. */
function countingScenario(ledger: string[]): ChaosScenario {
  return {
    name: 'counting',
    async drive(ctx) {
      for (const page of ['p1', 'p2', 'p3', 'p4', 'p5']) {
        // Effectively-once: a page already written is not written again, which
        // is what a checkpointed step does on resume (main §14.3.4).
        if (!ledger.includes(page)) ledger.push(page)
        ctx.checkpoint(`wrote ${page}`)
      }
    },
    async assert() {},
  }
}

describe('chaos harness', () => {
  it('actually kills the driver, and restarts it until a pass completes', async () => {
    const ledger: string[] = []
    const result = await runChaosScenario(countingScenario(ledger), {
      pool: harness.pool,
      accountId,
      seed: 7,
      kills: 3,
    })

    expect(result.kills).toBe(3)
    // Restarts include any pass whose drawn kill point overshot the run's
    // length, which the harness retries rather than counting as a kill.
    expect(result.restarts).toBeGreaterThanOrEqual(result.kills)
    // Convergence: the work landed exactly once despite three interruptions.
    expect(ledger).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
  })

  it('is reproducible: the same seed kills at the same points', async () => {
    const options = { pool: harness.pool, accountId, seed: 99, kills: 2 }
    const a = await runChaosScenario(countingScenario([]), options)
    const b = await runChaosScenario(countingScenario([]), options)
    expect(a.checkpointsReached).toEqual(b.checkpointsReached)
    expect(a.restarts).toBe(b.restarts)
  })

  it('fails a run that never converges rather than reporting it green', async () => {
    const neverFinishes: ChaosScenario = {
      name: 'never',
      async drive(ctx) {
        ctx.checkpoint('one')
        throw new WorkerKilled('always')
      },
      async assert() {},
    }

    await expect(
      runChaosScenario(neverFinishes, { pool: harness.pool, accountId, kills: 1, maxAttempts: 3 }),
    ).rejects.toThrow(/never completed within 3 attempts/)
  })

  it('propagates a real error instead of treating it as a kill', async () => {
    const broken: ChaosScenario = {
      name: 'broken',
      async drive() {
        throw new Error('a genuine bug')
      },
      async assert() {},
    }
    await expect(
      runChaosScenario(broken, { pool: harness.pool, accountId, kills: 0 }),
    ).rejects.toThrow('a genuine bug')
  })

  it('fails when a step is left unsettled', async () => {
    const { rows } = await harness.pool.query<{ id: string }>(
      `INSERT INTO ingestion_jobs (account_id, run_id) VALUES ($1, 'r1') RETURNING id`,
      [accountId],
    )
    await harness.pool.query(
      `INSERT INTO job_steps (job_id, step, state, idempotency_key)
       VALUES ($1, 'catalog_sync', 'failed_retryable', 'k1')`,
      [rows[0]!.id],
    )

    await expect(assertEveryStepSettled(harness.pool, accountId)).rejects.toThrow(
      /catalog_sync=failed_retryable/,
    )
  })

  it('accepts a skipped step as settled (main §14.3.1 — gsc_connect may be skipped)', async () => {
    const { rows } = await harness.pool.query<{ id: string }>(
      `INSERT INTO ingestion_jobs (account_id, run_id) VALUES ($1, 'r2') RETURNING id`,
      [accountId],
    )
    await harness.pool.query(
      `INSERT INTO job_steps (job_id, step, state, idempotency_key)
       VALUES ($1, 'gsc_connect', 'skipped', 'k2'), ($1, 'detect', 'succeeded', 'k3')`,
      [rows[0]!.id],
    )

    await expect(assertEveryStepSettled(harness.pool, accountId)).resolves.toBeUndefined()
  })

  it('catches a retry that re-billed a vendor read', () => {
    expect(() =>
      assertNoDoubleBilling({ billableCalls: 3, calls: [{ cacheHit: false }, { cacheHit: true }] }),
    ).toThrow(/does not equal distinct canonical requests/)

    expect(() =>
      assertNoDoubleBilling({ billableCalls: 1, calls: [{ cacheHit: false }, { cacheHit: true }] }),
    ).not.toThrow()
  })
})

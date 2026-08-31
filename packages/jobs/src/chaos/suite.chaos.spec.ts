import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { databaseAvailable, insertAccount, setupTestDb, type TestDb } from '@sortiva/db/testing'
import { CHAOS_SCENARIOS, runChaosScenario } from './harness'

/**
 * `pnpm chaos` — main §14.3.9's nightly test. Separate from `pnpm test` because
 * tech §5 runs it nightly rather than on every merge: it restarts a full
 * synthetic run several times per scenario.
 */

let harness: TestDb
let accountId: string

beforeAll(async () => {
  if (!(await databaseAvailable())) {
    throw new Error('Postgres is not reachable. Run `pnpm db:up` before `pnpm chaos`.')
  }
  harness = await setupTestDb('chaos')
  accountId = await insertAccount(harness.pool, 'chaos@example.com')
}, 60_000)

afterAll(async () => {
  await harness?.close()
})

describe('chaos scenarios (main §14.3.9)', () => {
  for (const scenario of CHAOS_SCENARIOS) {
    it(`${scenario.name} converges after repeated kills`, async () => {
      const result = await runChaosScenario(scenario, {
        pool: harness.pool,
        accountId,
        seed: 20260831,
        kills: 3,
      })
      expect(result.scenario).toBe(scenario.name)
    }, 120_000)
  }
})

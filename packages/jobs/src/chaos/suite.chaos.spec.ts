import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { databaseAvailable, insertAccount, setupTestDb, type TestDb } from '@sortiva/db/testing'
import { CHAOS_SCENARIOS, runChaosScenario } from './harness'

/**
 * `pnpm chaos` — the nightly kill-and-converge test. Separate from `pnpm test`
 * because it runs nightly rather than on every merge: it restarts a full
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
  // The shared synthetic account is a paying one, because the generation-cycle
  // scenarios cannot reach the pipeline at all without entitlement. Seeded here
  // rather than in a scenario's own setup: `subscriptions` has exactly one
  // writer in the product (invariant 16), enforced against every non-test file,
  // and a scenario file is not a test file.
  await harness.pool.query(
    `INSERT INTO subscriptions (account_id, stripe_subscription_id, price_id, status)
     VALUES ($1, 'sub_chaos', 'price_chaos', 'active') ON CONFLICT (account_id) DO NOTHING`,
    [accountId],
  )
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

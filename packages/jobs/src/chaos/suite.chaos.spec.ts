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

const KILL_BUDGET = 3

describe('chaos scenarios (main §14.3.9)', () => {
  for (const scenario of CHAOS_SCENARIOS) {
    it(`${scenario.name} converges after repeated kills`, async () => {
      const result = await runChaosScenario(scenario, {
        pool: harness.pool,
        accountId,
        seed: 20260831,
        kills: KILL_BUDGET,
      })
      expect(result.scenario).toBe(scenario.name)

      /**
       * The assertion that makes every other assertion in this file mean
       * something: this scenario was actually interrupted.
       *
       * A driver that reaches no checkpoint cannot be killed. The harness then
       * returns having killed nothing, runs the same convergence checks against
       * a pass that ran start to finish undisturbed, and reports success —
       * which is exactly what a chaos suite must never do. Renaming or removing
       * a scenario's checkpoint calls produces that state, and the nightly run
       * would have gone green on a suite that had stopped testing anything.
       *
       * **Deliberately not the stronger assertions**, both of which look right
       * and are wrong here:
       *
       * - *Not* "the kill budget was fully spent". Every one of these pipelines
       *   is resumable, so the work left after a kill is smaller than the work
       *   before it. Three scenarios converge honestly after one or two kills
       *   because by then there is genuinely nothing left to interrupt, and
       *   demanding three would fail a suite that is working.
       * - *Not* "the surviving pass reached at least one checkpoint". Same
       *   reason from the other end: the pass that finally completes is the one
       *   picking up the remainder, and the remainder can legitimately contain
       *   no checkpoint at all.
       *
       * A scenario that arranges its own interruption says so on itself, and
       * says why. Nothing here maintains a list of exceptions, so a scenario
       * added tomorrow is asserted unless its author writes down what kills it.
       */
      if (scenario.selfInterrupting === undefined) {
        expect(
          result.kills,
          `${scenario.name} completed without the harness ever killing it, so everything this ` +
            'test then asserted was asserted about an undisturbed run. Either its checkpoints ' +
            'have gone, or it interrupts itself — and if it interrupts itself, say so in ' +
            '`selfInterrupting` with what does the interrupting.',
        ).toBeGreaterThan(0)
      } else {
        // An opt-out with no reason is an opt-out nobody has to justify.
        expect(scenario.selfInterrupting.length).toBeGreaterThan(30)
      }
    }, 120_000)
  }
})

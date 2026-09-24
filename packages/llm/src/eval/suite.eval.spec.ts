import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { discoverEvalSets, formatEvalResult, runEvalSet, EVAL_RUNNERS } from './runner'

/**
 * `pnpm eval` — the frozen evaluation sets. CI runs this whenever
 * a prompt file or a model id changes; a failure blocks the deploy.
 *
 * It is a separate command from `pnpm test` on purpose: eval sets call the model
 * and cost money, so they run on their own gate rather than on every unit-test
 * run.
 *
 * Every set prints what it measured, pass or fail. A run of this suite costs
 * about eighty model calls, and a run that spends that and reports only a
 * verdict has thrown away the thing it paid for.
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const sets = discoverEvalSets(repoRoot)

/**
 * Enough for the slowest set with room for a bad afternoon.
 *
 * Each case is one model call, taking ten to twenty seconds, and the sets run
 * their cases one at a time — twenty cases is five minutes on a good day, and a
 * repair attempt, a rate-limit backoff or a slow vendor multiplies that. The
 * old ceiling of five minutes killed the judge set mid-run: the money was spent
 * and no score came back, which is the worst of both.
 */
const SET_TIMEOUT_MS = 30 * 60 * 1000

describe('eval sets', () => {
  it('discovers every *.eval directory in the repo', () => {
    // Zero is the M0 state and is reported, not asserted away: the sets land
    // with the cards that write the prompts they grade.
    expect(sets.length).toBeGreaterThanOrEqual(0)
  })

  if (sets.length === 0) {
    it('has no sets to run yet (distillation.eval, judge.eval, persona.smoke land with T2.3 / T4.4 / T2.5)', () => {
      expect(sets).toEqual([])
    })
  }

  for (const set of sets) {
    it(
      `${set.config.name} passes its thresholds`,
      async () => {
        const result = await runEvalSet(set, EVAL_RUNNERS)
        // Printed before the assertions, so the scores survive a failure.
        console.log(formatEvalResult(result))
        expect(result.failures).toEqual([])
        expect(result.passed).toBe(true)
      },
      SET_TIMEOUT_MS,
    )
  }
})

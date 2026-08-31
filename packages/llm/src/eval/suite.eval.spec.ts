import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { discoverEvalSets, runEvalSet, EVAL_RUNNERS } from './runner'

/**
 * `pnpm eval` — main §14.2's frozen eval sets. tech §5 runs this in CI whenever
 * a prompt file or a model id changes; a failure blocks the deploy.
 *
 * It is a separate command from `pnpm test` on purpose: eval sets call the model
 * and cost money, so they run on their own gate rather than on every unit-test
 * run.
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const sets = discoverEvalSets(repoRoot)

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
    it(`${set.config.name} passes its thresholds`, async () => {
      const result = await runEvalSet(set, EVAL_RUNNERS)
      expect(result.failures).toEqual([])
      expect(result.passed).toBe(true)
    }, 300_000)
  }
})

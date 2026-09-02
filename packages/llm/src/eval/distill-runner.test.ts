import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { LlmValidationFailure } from '@sortiva/core'
import { MockLlmClient } from '../mock'
import { distillEvalRunner, type DistillEvalInput } from './distill-runner'
import { loadEvalSet, runEvalSet, EVAL_RUNNERS, type EvalRunnerRegistry } from './runner'

/**
 * `distillation.eval` itself runs on its own gate (`pnpm eval`) against the
 * real model, because grading a stand-in grades nothing.
 *
 * What runs *here*, on every merge, is everything around that model call: the
 * set loads, every case has a hand-written expected sheet, the prompt renders,
 * the schema is enforced, the F1 threshold bites, and a fabricated field value
 * fails its case on its own rather than being averaged away. Those are the
 * parts that break silently when someone edits the runner; the model's own
 * accuracy is the part that needs the key.
 */

const SET_DIR = fileURLToPath(new URL('../../eval/distillation.eval', import.meta.url))
const set = loadEvalSet(SET_DIR)

/** The ten extracted fields, as the graded prediction and the gold sheet both carry them. */
type GoldSheet = Record<string, unknown>

function goldByTitle(): Map<string, GoldSheet> {
  const map = new Map<string, GoldSheet>()
  for (const testCase of set.cases) {
    map.set((testCase.input as DistillEvalInput).title, testCase.gold as GoldSheet)
  }
  return map
}

/** Answers each case with its own expected sheet: a model that is exactly right. */
function perfectClient(): MockLlmClient {
  const gold = goldByTitle()
  const client = new MockLlmClient()
  client.setDefault('distill', (request) => {
    const sheet = gold.get(titleOf(request.messages))
    if (!sheet) throw new Error(`no gold sheet for the prompt: ${titleOf(request.messages)}`)
    // The gold files hold only the graded fields; `fluff_discarded` is part of
    // the model's contract but is not graded, so it is supplied here.
    return JSON.stringify({ ...sheet, fluff_discarded: false })
  })
  return client
}

function titleOf(messages: readonly { content: string }[]): string {
  const match = messages[0]?.content.match(/^Product title: (.*)$/m)
  return match?.[1] ?? ''
}

function registryFor(client: MockLlmClient): EvalRunnerRegistry {
  return { distill: distillEvalRunner(client) }
}

describe('distillation.eval, the set itself', () => {
  it('holds the ~50 cases the frozen set calls for, each with an expected sheet', () => {
    expect(set.config.name).toBe('distillation')
    expect(set.config.minF1).toBe(0.85)
    expect(set.config.allowFabricatedFacts).toBe(false)
    expect(set.cases.length).toBeGreaterThanOrEqual(50)
  })

  it('grades only the ten extracted fields', () => {
    for (const testCase of set.cases) {
      const gold = testCase.gold as GoldSheet
      expect(Object.keys(gold).sort()).toEqual(
        [
          'capacity',
          'care',
          'certifications',
          'compatibility',
          'dimensions',
          'material',
          'origin',
          'use_cases_stated',
          'verifiable_claims',
          'weight',
        ].sort(),
      )
    }
  })

  it('is registered, so the suite runs it rather than silently skipping it', () => {
    expect(Object.keys(EVAL_RUNNERS)).toContain('distill')
  })

  it('includes cases whose correct answer is nothing at all', () => {
    const empty = set.cases.filter((testCase) =>
      Object.values(testCase.gold as GoldSheet).every(
        (value) => value === null || (Array.isArray(value) && value.length === 0),
      ),
    )
    // Pure marketing copy yields no facts, and a set without such a case would
    // never notice a model that answers every product with something.
    expect(empty.length).toBeGreaterThanOrEqual(2)
  })
})

describe('distillation.eval, the grading', () => {
  it('passes when every sheet matches', async () => {
    const result = await runEvalSet(set, registryFor(perfectClient()))
    expect(result.failures).toEqual([])
    expect(result.passed).toBe(true)
    expect(result.f1).toBe(1)
    expect(result.caseCount).toBe(set.cases.length)
  })

  it('fails the case that invents a field value, whatever the rest of the set scores', async () => {
    const gold = goldByTitle()
    const client = new MockLlmClient()
    client.setDefault('distill', (request) => {
      const title = titleOf(request.messages)
      const sheet: GoldSheet = { ...(gold.get(title) as GoldSheet), fluff_discarded: false }
      // One product in fifty gets a material nobody wrote down.
      if (title === 'Aurora Scented Candle') sheet.material = 'hand-poured soy wax'
      return JSON.stringify(sheet)
    })

    const result = await runEvalSet(set, registryFor(client))
    expect(result.passed).toBe(false)
    expect(result.failures.join('\n')).toContain('fabricated material=hand-poured soy wax')
    // The aggregate is still excellent — which is exactly why the hard fail is
    // checked per case rather than read off the average.
    expect(result.f1).toBeGreaterThan(0.99)
  })

  it('fails the set when the extraction stops finding anything', async () => {
    const client = new MockLlmClient()
    client.setDefault('distill', () =>
      JSON.stringify({
        material: null,
        dimensions: null,
        weight: null,
        capacity: null,
        compatibility: [],
        use_cases_stated: [],
        care: null,
        certifications: [],
        origin: null,
        verifiable_claims: [],
        fluff_discarded: false,
      }),
    )

    const result = await runEvalSet(set, registryFor(client))
    expect(result.passed).toBe(false)
    expect(result.failures.join('\n')).toContain('is below the required 0.85')
  })

  it('refuses a completion that does not fit the fact-sheet contract', async () => {
    const client = new MockLlmClient()
    // A plausible-looking answer with a field nobody downstream can read, and
    // one the schema requires missing.
    client.setDefault('distill', () => JSON.stringify({ material: 'leather', colour: 'tan' }))

    await expect(distillEvalRunner(client)(set.cases[0]!.input, set.config)).rejects.toBeInstanceOf(
      LlmValidationFailure,
    )
    // One repair attempt, then it stops — never a third call to talk the model
    // into a shape it keeps missing.
    expect(client.countOf('distill')).toBe(2)
  })

  it('sends the versioned prompt and stamps the call with it', async () => {
    const client = perfectClient()
    await distillEvalRunner(client)(set.cases[0]!.input, set.config)
    expect(client.calls[0]?.promptVersion).toBe('distill.v1')
    expect(client.calls[0]?.modelId).toBe('claude-haiku-4-5')
  })
})

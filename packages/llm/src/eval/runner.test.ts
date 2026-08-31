import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverEvalSets, loadEvalSet, runEvalSet, type EvalSetConfig } from './runner'
import { fieldF1, meanAbsoluteError } from './metrics'

/** main §14.2 — the eval machinery, including both hard-fail rules. */

const temporaryDirs: string[] = []

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeSet(
  config: Partial<EvalSetConfig> & { name: string },
  cases: { id: string; input: unknown; gold: unknown }[],
): string {
  const root = mkdtempSync(join(tmpdir(), 'sortiva-eval-'))
  temporaryDirs.push(root)
  const dir = join(root, `${config.name}.eval`)
  mkdirSync(join(dir, 'cases'), { recursive: true })
  writeFileSync(
    join(dir, 'eval.json'),
    JSON.stringify({ metric: 'field_f1', runner: 'test', ...config }),
  )
  for (const testCase of cases) {
    writeFileSync(join(dir, 'cases', `${testCase.id}.input.json`), JSON.stringify(testCase.input))
    writeFileSync(join(dir, 'cases', `${testCase.id}.gold.json`), JSON.stringify(testCase.gold))
  }
  return root
}

describe('metrics', () => {
  it('scores field-level F1 on field=value pairs, not field names', () => {
    const score = fieldF1({ material: 'nylon', weight: '200' }, { material: 'leather', weight: '200' })
    expect(score.truePositives).toBe(1)
    // Calling the material "nylon" when it is leather is a fabrication, not a
    // correctly-populated field.
    expect(score.fabricated).toEqual(['material=nylon'])
  })

  it('treats a blank or missing value as absent, not as a wrong answer', () => {
    expect(fieldF1({ material: '', weight: '200' }, { weight: '200' }).f1).toBe(1)
  })

  it('charges the full gold value when a criterion is simply omitted', () => {
    const mae = meanAbsoluteError([{ predicted: {}, gold: { information_gain: 4 } }])
    expect(mae.perCriterion.information_gain).toBe(4)
  })

  it('reports MAE per criterion and names the worst', () => {
    const mae = meanAbsoluteError([
      { predicted: { a: 4, b: 3 }, gold: { a: 4, b: 5 } },
      { predicted: { a: 3, b: 4 }, gold: { a: 4, b: 5 } },
    ])
    expect(mae.perCriterion.a).toBeCloseTo(0.5, 6)
    expect(mae.perCriterion.b).toBeCloseTo(1.5, 6)
    expect(mae.worstCriterion).toBe('b')
  })
})

describe('eval sets', () => {
  it('runs green on an empty set — nothing is being claimed', async () => {
    const root = makeSet({ name: 'empty' }, [])
    const [set] = discoverEvalSets(root)
    const result = await runEvalSet(set!, {})
    expect(result).toMatchObject({ passed: true, caseCount: 0 })
  })

  it('fails when cases exist but no runner is registered', async () => {
    const root = makeSet({ name: 'orphan' }, [{ id: '001', input: {}, gold: { a: 1 } }])
    const [set] = discoverEvalSets(root)
    const result = await runEvalSet(set!, {})
    expect(result.passed).toBe(false)
    expect(result.failures[0]).toMatch(/silently not run/)
  })

  it('refuses a case with an input and no gold file', () => {
    const root = mkdtempSync(join(tmpdir(), 'sortiva-eval-'))
    temporaryDirs.push(root)
    const dir = join(root, 'lopsided.eval')
    mkdirSync(join(dir, 'cases'), { recursive: true })
    writeFileSync(join(dir, 'eval.json'), JSON.stringify({ name: 'lopsided', metric: 'field_f1', runner: 'x' }))
    writeFileSync(join(dir, 'cases', '001.input.json'), '{}')
    expect(() => loadEvalSet(dir)).toThrow(/no 001\.gold\.json/)
  })

  it('hard-fails a fabricated fact even when the aggregate F1 clears the bar', async () => {
    const gold = { material: 'leather', weight: '200', drop: '8', use: 'trail' }
    const root = makeSet({ name: 'distillation', minF1: 0.85 }, [{ id: '001', input: {}, gold }])
    const [set] = discoverEvalSets(root)

    const result = await runEvalSet(set!, {
      test: async () => ({ ...gold, waterproofing: 'GORE-TEX' }),
    })

    expect(result.f1).toBeGreaterThan(0.85)
    expect(result.passed).toBe(false)
    expect(result.failures[0]).toMatch(/fabricated waterproofing=gore-tex/)
  })

  it('hard-fails a false pass on the judge metric', async () => {
    const root = makeSet({ name: 'judge', metric: 'criterion_mae', maxMae: 0.5 }, [
      { id: '001', input: {}, gold: { information_gain: 2, passed: false } },
    ])
    const [set] = discoverEvalSets(root)

    const result = await runEvalSet(set!, {
      test: async () => ({ information_gain: 2, passed: true }),
    })

    // The scores are perfect; the verdict is not — and §14.2 says the verdict
    // is what matters.
    expect(result.mae?.perCriterion.information_gain).toBe(0)
    expect(result.passed).toBe(false)
    expect(result.failures[0]).toMatch(/false pass/)
  })

  it('fails a per-criterion MAE above the threshold', async () => {
    const root = makeSet({ name: 'judge', metric: 'criterion_mae', maxMae: 0.5 }, [
      { id: '001', input: {}, gold: { grounding: 5 } },
      { id: '002', input: {}, gold: { grounding: 5 } },
    ])
    const [set] = discoverEvalSets(root)
    const result = await runEvalSet(set!, { test: async () => ({ grounding: 3 }) })
    expect(result.failures[0]).toMatch(/"grounding" MAE 2\.000 exceeds 0\.5/)
  })
})

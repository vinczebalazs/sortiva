import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  discoverEvalSets,
  formatEvalResult,
  loadEvalSet,
  runEvalSet,
  type EvalSetConfig,
} from './runner'
import { fieldF1, meanAbsoluteError } from './metrics'

/** The evaluation machinery, including both hard-fail rules. */

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

  describe('what is not a fabrication (remediation eval card 3)', () => {
    it('compares a list item by item, so four right out of five is four hits and a miss', () => {
      const score = fieldF1(
        { verifiable_claims: ['800 lumens', 'IPX6', 'runtime 10 hours', 'USB-C'] },
        { verifiable_claims: ['800 lumens', 'IPX6', 'runtime 10 hours', 'USB-C', 'weighs 95 g'] },
      )
      expect(score.truePositives).toBe(4)
      expect(score.fabricated).toEqual([])
      expect(score.falseNegatives).toBe(1)
    })

    it('does not call a trailing full stop an invented value', () => {
      const score = fieldF1(
        { care: 'Wipe clean with a damp cloth.' },
        { care: 'Wipe clean with a damp cloth' },
      )
      expect(score.fabricated).toEqual([])
      expect(score.f1).toBe(1)
    })

    it('treats an empty list as an answer not given, never as an answer invented', () => {
      const score = fieldF1(
        { verifiable_claims: [] },
        { verifiable_claims: ['holds 18 L', 'measures 38 x 30 x 14 cm'] },
      )
      // Nothing was made up here; the model declined to answer.
      expect(score.fabricated).toEqual([])
      expect(score.falseNegatives).toBe(2)
      expect(score.recall).toBe(0)
    })

    it('scores nothing at all for agreeing that a field is empty', () => {
      const score = fieldF1(
        { compatibility: [], material: 'leather' },
        { compatibility: [], material: 'leather' },
      )
      // The old scorer counted `compatibility=` as a hit on both sides, so a
      // sheet of empty fields earned free credit for saying nothing.
      expect(score.truePositives).toBe(1)
      expect(score.f1).toBe(1)
    })

    it('still calls an invented list item what it is', () => {
      const score = fieldF1(
        { certifications: ['OEKO-TEX', 'GOTS'] },
        { certifications: ['OEKO-TEX'] },
      )
      expect(score.fabricated).toEqual(['certifications=gots'])
      expect(score.truePositives).toBe(1)
    })
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

    // The scores are perfect; the verdict is not — and it is the verdict
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

describe('what a run reports (remediation eval card 2)', () => {
  it('says what every case scored on a set that passes, not only on one that fails', async () => {
    const gold = { material: 'leather', weight: '200' }
    const root = makeSet({ name: 'distillation', minF1: 0.85 }, [
      { id: '001', input: {}, gold },
      { id: '002', input: {}, gold },
    ])
    const [set] = discoverEvalSets(root)
    const result = await runEvalSet(set!, { test: async () => gold })

    expect(result.passed).toBe(true)
    expect(result.cases.map((c) => c.caseId)).toEqual(['001', '002'])
    expect(result.cases[0]!.detail).toContain('F1 1.000')
    expect(result.precision).toBe(1)
    expect(result.recall).toBe(1)

    const printed = formatEvalResult(result)
    expect(printed).toContain('distillation — PASS')
    expect(printed).toContain('field F1 1.000')
    expect(printed).toContain('001')
  })

  it('prints every criterion the judge was graded on, not only the ones that breached', async () => {
    const root = makeSet({ name: 'judge', metric: 'criterion_mae', maxMae: 0.5 }, [
      { id: '001', input: {}, gold: { grounding: 5, gain: 4, passed: true } },
    ])
    const [set] = discoverEvalSets(root)
    const result = await runEvalSet(set!, { test: async () => ({ grounding: 3, gain: 4, passed: false }) })

    const printed = formatEvalResult(result)
    // `gain` is inside the pass mark and would have gone unmentioned before.
    expect(printed).toContain('gain')
    expect(printed).toContain('grounding')
    expect(result.cases[0]!.detail).toContain('grounding 3/5')
    expect(result.cases[0]!.detail).toContain('judge rejects it, humans passed it')
  })

  it('names the field an exact-match case got wrong and what it answered instead', async () => {
    const root = makeSet({ name: 'persona', metric: 'exact_match' }, [
      { id: '001', input: {}, gold: { country: 'DE', main_language: 'de' } },
    ])
    const [set] = discoverEvalSets(root)
    const result = await runEvalSet(set!, {
      test: async () => ({ country: 'AT', main_language: 'de' }),
    })

    expect(result.exactMatches).toBe(0)
    expect(result.cases[0]!.detail).toContain('country "AT", expected "DE"')
    expect(formatEvalResult(result)).toContain('exactly right: 0 of 1')
  })
})

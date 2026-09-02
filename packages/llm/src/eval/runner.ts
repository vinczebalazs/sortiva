import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { distillEvalRunner } from './distill-runner'
import { fieldF1, meanAbsoluteError, type F1Score, type MaeScore } from './metrics'

/**
 * Frozen evaluation sets, run in CI whenever a prompt file or a model id
 * changes. A deploy blocks on failure.
 *
 * An eval set is a directory named `<name>.eval` holding an `eval.json` and a
 * `cases/` folder of `<id>.input.json` / `<id>.gold.json` pairs. The names the
 * fixed names — `distillation.eval`, `judge.eval`, `persona.smoke` — are
 * directory names here, so CI and audits can find them (CLAUDE.md).
 *
 * Sets are **append-only**: a production failure gets minimised and
 * added as a regression case. Nothing here deletes or rewrites a case.
 *
 * The set declares which *runner* produces a prediction from an input; runners
 * are registered by the card that owns the prompt. M0 ships the machinery and
 * an empty registry, so `pnpm eval` on a repo with no cases passes.
 */

export type EvalMetric = 'field_f1' | 'criterion_mae' | 'exact_match'

export interface EvalSetConfig {
  /** Matches the directory name without `.eval`. */
  readonly name: string
  readonly metric: EvalMetric
  /** Key in the runner registry. Absent from the registry = the set cannot run. */
  readonly runner: string
  readonly promptVersion?: string
  /** Minimum F1 the set must reach (`field_f1`). Distillation is held to 0.85. */
  readonly minF1?: number
  /** Maximum per-criterion error against the human grades. The judge is held to 0.5. */
  readonly maxMae?: number
  /**
   * Hard fails that no aggregate may absorb: a fabricated field value, or a
   * draft humans failed being graded as passing. A set that averaged these away
   * would report health while shipping the two failures that matter most.
   */
  readonly allowFabricatedFacts?: boolean
  readonly allowFalsePass?: boolean
  readonly description?: string
}

export interface EvalCase {
  readonly id: string
  readonly input: unknown
  readonly gold: unknown
}

export interface EvalSet {
  readonly config: EvalSetConfig
  readonly directory: string
  readonly cases: readonly EvalCase[]
}

/** What a registered runner must do: turn one case's input into a prediction. */
export type EvalRunner = (input: unknown, config: EvalSetConfig) => Promise<unknown>

export type EvalRunnerRegistry = Readonly<Record<string, EvalRunner>>

export interface CaseResult {
  readonly caseId: string
  readonly passed: boolean
  readonly detail: string
  readonly f1?: F1Score
}

export interface EvalSetResult {
  readonly name: string
  readonly passed: boolean
  readonly caseCount: number
  readonly failures: readonly string[]
  readonly f1?: number
  readonly mae?: MaeScore
}

/** Walks a tree and returns every `*.eval` directory found. */
export function discoverEvalSets(root: string): EvalSet[] {
  const found: EvalSet[] = []
  if (!existsSync(root)) return found

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue
      const full = join(dir, entry)
      if (!statSync(full).isDirectory()) continue
      if (entry.endsWith('.eval')) {
        found.push(loadEvalSet(full))
        continue
      }
      walk(full)
    }
  }

  walk(root)
  return found.sort((a, b) => a.config.name.localeCompare(b.config.name))
}

export function loadEvalSet(directory: string): EvalSet {
  const configPath = join(directory, 'eval.json')
  if (!existsSync(configPath)) {
    throw new Error(`${directory} is an eval set with no eval.json`)
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as EvalSetConfig

  const casesDir = join(directory, 'cases')
  const cases: EvalCase[] = []
  if (existsSync(casesDir)) {
    const ids = [
      ...new Set(
        readdirSync(casesDir)
          .filter((f) => f.endsWith('.input.json'))
          .map((f) => f.replace('.input.json', '')),
      ),
    ].sort()

    for (const id of ids) {
      const goldPath = join(casesDir, `${id}.gold.json`)
      if (!existsSync(goldPath)) {
        // A case with no gold file is not a case — it is a silent pass waiting
        // to happen.
        throw new Error(`${config.name}: case "${id}" has an input but no ${id}.gold.json`)
      }
      cases.push({
        id,
        input: JSON.parse(readFileSync(join(casesDir, `${id}.input.json`), 'utf8')),
        gold: JSON.parse(readFileSync(goldPath, 'utf8')),
      })
    }
  }

  return { config, directory, cases }
}

/**
 * Runs one set. A set with no cases passes — that is the state M0 ships in, and
 * it is honest: nothing is being claimed. A set *with* cases and no registered
 * runner fails, because that state is a suite silently not running.
 */
export async function runEvalSet(
  set: EvalSet,
  registry: EvalRunnerRegistry,
): Promise<EvalSetResult> {
  const { config, cases } = set

  if (cases.length === 0) {
    return { name: config.name, passed: true, caseCount: 0, failures: [] }
  }

  const runner = registry[config.runner]
  if (!runner) {
    return {
      name: config.name,
      passed: false,
      caseCount: cases.length,
      failures: [
        `no runner registered for "${config.runner}" — ${cases.length} case(s) would silently not run`,
      ],
    }
  }

  const failures: string[] = []
  const predictions: unknown[] = []
  for (const testCase of cases) {
    predictions.push(await runner(testCase.input, config))
  }

  if (config.metric === 'field_f1') {
    let truePositives = 0
    let falsePositives = 0
    let falseNegatives = 0

    for (const [index, testCase] of cases.entries()) {
      const score = fieldF1(
        predictions[index] as Record<string, unknown>,
        testCase.gold as Record<string, unknown>,
      )
      truePositives += score.truePositives
      falsePositives += score.falsePositives
      falseNegatives += score.falseNegatives

      // Any fabricated field value fails outright, checked per case so the
      // aggregate cannot absorb it.
      if (!config.allowFabricatedFacts && score.fabricated.length > 0) {
        failures.push(`case ${testCase.id}: fabricated ${score.fabricated.join(', ')}`)
      }
    }

    const precision = truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives)
    const recall = truePositives + falseNegatives === 0 ? 1 : truePositives / (truePositives + falseNegatives)
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)

    if (config.minF1 !== undefined && f1 < config.minF1) {
      failures.push(`field F1 ${f1.toFixed(3)} is below the required ${config.minF1}`)
    }
    return { name: config.name, passed: failures.length === 0, caseCount: cases.length, failures, f1 }
  }

  if (config.metric === 'criterion_mae') {
    const pairs = cases.map((testCase, index) => ({
      predicted: predictions[index] as Record<string, number>,
      gold: testCase.gold as Record<string, number>,
    }))
    const mae = meanAbsoluteError(pairs)

    if (config.maxMae !== undefined) {
      for (const [criterion, value] of Object.entries(mae.perCriterion)) {
        if (value > config.maxMae) {
          failures.push(`criterion "${criterion}" MAE ${value.toFixed(3)} exceeds ${config.maxMae}`)
        }
      }
    }

    // No draft that humans failed may be graded as passing. A gold case marks
    // itself failed with `passed: false`.
    if (!config.allowFalsePass) {
      for (const [index, testCase] of cases.entries()) {
        const gold = testCase.gold as { passed?: boolean }
        const predicted = predictions[index] as { passed?: boolean }
        if (gold.passed === false && predicted.passed === true) {
          failures.push(`case ${testCase.id}: false pass — humans failed this draft`)
        }
      }
    }

    return { name: config.name, passed: failures.length === 0, caseCount: cases.length, failures, mae }
  }

  for (const [index, testCase] of cases.entries()) {
    if (JSON.stringify(predictions[index]) !== JSON.stringify(testCase.gold)) {
      failures.push(`case ${testCase.id}: does not match gold exactly`)
    }
  }
  return { name: config.name, passed: failures.length === 0, caseCount: cases.length, failures }
}

/**
 * The registry the eval suite runs against. Cards that add a prompt register its
 * runner here: `distill` (T2.3), `persona` (T2.5), `judge` (T4.4). A set whose
 * runner is missing fails rather than skips, so a suite that is not running
 * cannot look like a suite that is passing.
 *
 * `distillEvalRunner()` builds the real Anthropic client on first use, inside
 * the runner call — the registry is a module constant, and constructing a
 * client here would need a key merely to import this file.
 */
export const EVAL_RUNNERS: EvalRunnerRegistry = {
  distill: (input, config) => distillEvalRunner()(input, config),
}

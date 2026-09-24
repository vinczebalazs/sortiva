import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { distillEvalRunner } from './distill-runner'
import { judgeEvalRunner } from './judge-runner'
import { personaEvalRunner } from './persona-runner'
import { fieldF1, meanAbsoluteError, type F1Score, type MaeScore } from './metrics'

/**
 * Frozen evaluation sets, run in CI whenever a prompt file or a model id
 * changes. A deploy blocks on failure.
 *
 * An eval set is a directory named `<name>.eval` — or `<name>.smoke` — holding
 * an `eval.json` and a `cases/` folder of `<id>.input.json` / `<id>.gold.json`
 * pairs. The fixed names — `distillation.eval`, `judge.eval`, `persona.smoke` —
 * are directory names here, so CI and audits can find them (CLAUDE.md).
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
  /** Matches the directory name without its `.eval` / `.smoke` suffix. */
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
  /**
   * What every case actually scored, pass or fail.
   *
   * A set that reports only its breaches reports nothing on the run where it
   * passes, and "nothing" is what a suite that is not running looks like too.
   * These numbers are the output of an eval; the verdict is a comparison drawn
   * from them.
   */
  readonly cases: readonly CaseResult[]
  /** Aggregate precision and recall behind the F1, for `field_f1` sets. */
  readonly precision?: number
  readonly recall?: number
  /** How many cases matched their gold answer exactly, for `exact_match` sets. */
  readonly exactMatches?: number
  /** Wall clock, model calls included — the figure the suite's own timeout has to clear. */
  readonly durationMs: number
}

/**
 * The directory suffixes that mark an evaluation set.
 *
 * `.smoke` is here because the spec fixes the sets' names and one of them is
 * `persona.smoke`, not `persona.eval`. Recognising only `.eval` would mean the
 * persona set could be written, committed and reviewed while being discovered
 * by nothing — a suite that is not running looking exactly like a suite that is
 * passing, which is the one failure this whole file is built to prevent.
 */
const EVAL_SET_SUFFIXES = ['.eval', '.smoke']

/** Walks a tree and returns every evaluation-set directory found. */
export function discoverEvalSets(root: string): EvalSet[] {
  const found: EvalSet[] = []
  if (!existsSync(root)) return found

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue
      const full = join(dir, entry)
      if (!statSync(full).isDirectory()) continue
      if (EVAL_SET_SUFFIXES.some((suffix) => entry.endsWith(suffix))) {
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

  const startedAt = Date.now()

  if (cases.length === 0) {
    return { name: config.name, passed: true, caseCount: 0, failures: [], cases: [], durationMs: 0 }
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
      cases: [],
      durationMs: Date.now() - startedAt,
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
    const caseResults: CaseResult[] = []

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
      const fabricated = !config.allowFabricatedFacts && score.fabricated.length > 0
      if (fabricated) {
        failures.push(`case ${testCase.id}: fabricated ${score.fabricated.join(', ')}`)
      }

      caseResults.push({
        caseId: testCase.id,
        passed: !fabricated,
        detail:
          `F1 ${score.f1.toFixed(3)} · ${score.truePositives} right, ${score.falseNegatives} missed` +
          (score.fabricated.length === 0
            ? ', nothing invented'
            : `, invented ${score.fabricated.join(', ')}`),
        f1: score,
      })
    }

    const precision = truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives)
    const recall = truePositives + falseNegatives === 0 ? 1 : truePositives / (truePositives + falseNegatives)
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)

    if (config.minF1 !== undefined && f1 < config.minF1) {
      failures.push(`field F1 ${f1.toFixed(3)} is below the required ${config.minF1}`)
    }
    return {
      name: config.name,
      passed: failures.length === 0,
      caseCount: cases.length,
      failures,
      f1,
      precision,
      recall,
      cases: caseResults,
      durationMs: Date.now() - startedAt,
    }
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
    const caseResults: CaseResult[] = []
    for (const [index, testCase] of cases.entries()) {
      const gold = testCase.gold as Record<string, unknown> & { passed?: boolean }
      const predicted = predictions[index] as Record<string, unknown> & { passed?: boolean }
      const falsePass =
        !config.allowFalsePass && gold.passed === false && predicted.passed === true
      if (falsePass) {
        failures.push(`case ${testCase.id}: false pass — humans failed this draft`)
      }

      const scored = Object.keys(gold)
        .filter((key) => typeof gold[key] === 'number')
        .map((key) => `${key} ${String(predicted[key] ?? '—')}/${String(gold[key])}`)
      caseResults.push({
        caseId: testCase.id,
        passed: !falsePass,
        detail:
          `${scored.join(' · ')} · judge ${predicted.passed ? 'passes' : 'rejects'} it` +
          (gold.passed === undefined ? '' : `, humans ${gold.passed ? 'passed' : 'failed'} it`),
      })
    }

    return {
      name: config.name,
      passed: failures.length === 0,
      caseCount: cases.length,
      failures,
      mae,
      cases: caseResults,
      durationMs: Date.now() - startedAt,
    }
  }

  const caseResults: CaseResult[] = []
  for (const [index, testCase] of cases.entries()) {
    const matched = JSON.stringify(predictions[index]) === JSON.stringify(testCase.gold)
    if (!matched) failures.push(`case ${testCase.id}: does not match gold exactly`)
    caseResults.push({
      caseId: testCase.id,
      passed: matched,
      detail: matched ? 'exactly as expected' : disagreements(predictions[index], testCase.gold),
    })
  }
  return {
    name: config.name,
    passed: failures.length === 0,
    caseCount: cases.length,
    failures,
    exactMatches: caseResults.filter((c) => c.passed).length,
    cases: caseResults,
    durationMs: Date.now() - startedAt,
  }
}

/** Which fields an exact-match case got wrong, and what it said instead. */
function disagreements(predicted: unknown, gold: unknown): string {
  if (typeof gold !== 'object' || gold === null) return `answered ${JSON.stringify(predicted)}`
  const answer = (predicted ?? {}) as Record<string, unknown>
  const wrong = Object.entries(gold as Record<string, unknown>)
    .filter(([key, value]) => JSON.stringify(answer[key]) !== JSON.stringify(value))
    .map(([key, value]) => `${key} ${JSON.stringify(answer[key]) ?? 'missing'}, expected ${JSON.stringify(value)}`)
  return wrong.join(' · ')
}

/**
 * The whole of what a set measured, printed on a pass as well as on a failure.
 *
 * The first run of this suite had to be done from a throwaway script, because
 * `pnpm eval` printed the breaches and nothing else: a passing set said nothing
 * at all, and the scores are the point of running it.
 */
export function formatEvalResult(result: EvalSetResult): string {
  const lines: string[] = []
  const seconds = (result.durationMs / 1000).toFixed(1)
  lines.push(
    `\n${result.name} — ${result.passed ? 'PASS' : 'FAIL'} · ${result.caseCount} case(s) · ${seconds}s`,
  )

  if (result.f1 !== undefined) {
    lines.push(
      `  field F1 ${result.f1.toFixed(3)}` +
        (result.precision === undefined
          ? ''
          : ` (precision ${result.precision.toFixed(3)}, recall ${result.recall!.toFixed(3)})`),
    )
    const invented = result.cases.filter((c) => !c.passed).length
    lines.push(`  cases with an invented value: ${invented} of ${result.caseCount}`)
  }

  if (result.mae) {
    for (const [criterion, value] of Object.entries(result.mae.perCriterion)) {
      lines.push(`  ${criterion.padEnd(24)} error against the human grade ${value.toFixed(3)}`)
    }
    lines.push(`  ${'overall'.padEnd(24)} error against the human grade ${result.mae.overall.toFixed(3)}`)
  }

  if (result.exactMatches !== undefined) {
    lines.push(`  exactly right: ${result.exactMatches} of ${result.caseCount}`)
  }

  for (const c of result.cases) {
    lines.push(`  ${c.passed ? ' ' : '!'} ${c.caseId.padEnd(26)} ${c.detail}`)
  }

  for (const failure of result.failures) lines.push(`  BREACH: ${failure}`)

  return lines.join('\n')
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
  persona: (input, config) => personaEvalRunner()(input, config),
  judge: (input, config) => judgeEvalRunner()(input, config),
}

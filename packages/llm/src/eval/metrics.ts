/**
 * The two scorers main §14.2's eval sets are graded on.
 *
 * *Distillation eval:* "field-level F1 ≥ 0.85 and **zero** inferred-fact
 * violations (any fabricated field value = hard fail)."
 * *Judge eval:* "per-criterion MAE ≤ 0.5 **and** no draft that humans failed is
 * graded as passing (false-pass = hard fail)."
 *
 * Both hard-fail conditions are separate from the aggregate score on purpose: an
 * average can absorb a fabrication or a false pass, which is exactly the failure
 * mode the spec refuses to tolerate.
 */

export interface F1Score {
  readonly precision: number
  readonly recall: number
  readonly f1: number
  readonly truePositives: number
  readonly falsePositives: number
  readonly falseNegatives: number
  /** Predicted items absent from the gold set — a fabricated field value. */
  readonly fabricated: readonly string[]
}

/**
 * Field-level F1 over `field=value` pairs. Comparing pairs rather than field
 * names is what makes "said the material is leather when it is nylon" a
 * fabrication rather than a correct field.
 */
export function fieldF1(
  predicted: Readonly<Record<string, unknown>>,
  gold: Readonly<Record<string, unknown>>,
): F1Score {
  const predictedPairs = new Set(pairs(predicted))
  const goldPairs = new Set(pairs(gold))

  const truePositives = [...predictedPairs].filter((p) => goldPairs.has(p))
  const fabricated = [...predictedPairs].filter((p) => !goldPairs.has(p))
  const missed = [...goldPairs].filter((p) => !predictedPairs.has(p))

  const precision = predictedPairs.size === 0 ? 1 : truePositives.length / predictedPairs.size
  const recall = goldPairs.size === 0 ? 1 : truePositives.length / goldPairs.size
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)

  return {
    precision,
    recall,
    f1,
    truePositives: truePositives.length,
    falsePositives: fabricated.length,
    falseNegatives: missed.length,
    fabricated,
  }
}

export interface MaeScore {
  /** Mean absolute error across every criterion of every case. */
  readonly overall: number
  /** Per-criterion mean absolute error — what §14.2 actually gates on. */
  readonly perCriterion: Readonly<Record<string, number>>
  readonly worstCriterion: string | undefined
}

/**
 * Mean absolute error per criterion. `predicted` and `gold` are one case each;
 * the caller folds the pairs across a set with `meanAbsoluteError`.
 */
export function meanAbsoluteError(
  cases: readonly {
    predicted: Readonly<Record<string, number>>
    gold: Readonly<Record<string, number>>
  }[],
): MaeScore {
  const sums = new Map<string, { total: number; count: number }>()

  for (const { predicted, gold } of cases) {
    for (const [criterion, goldValue] of Object.entries(gold)) {
      const predictedValue = predicted[criterion]
      if (typeof predictedValue !== 'number') {
        // A missing criterion is not a zero error. Counting it as the full
        // scale keeps a model that simply omits hard criteria from scoring well.
        record(sums, criterion, Math.abs(goldValue))
        continue
      }
      record(sums, criterion, Math.abs(predictedValue - goldValue))
    }
  }

  const perCriterion: Record<string, number> = {}
  for (const [criterion, { total, count }] of sums) {
    perCriterion[criterion] = count === 0 ? 0 : total / count
  }

  const entries = Object.entries(perCriterion)
  const overall =
    entries.length === 0 ? 0 : entries.reduce((n, [, v]) => n + v, 0) / entries.length
  const worst = entries.sort((a, b) => b[1] - a[1])[0]

  return { overall, perCriterion, worstCriterion: worst?.[0] }
}

function record(sums: Map<string, { total: number; count: number }>, key: string, error: number) {
  const entry = sums.get(key) ?? { total: 0, count: 0 }
  entry.total += error
  entry.count += 1
  sums.set(key, entry)
}

function pairs(record: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(record)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${normalise(value)}`)
}

function normalise(value: unknown): string {
  if (typeof value === 'string') return value.trim().toLowerCase()
  if (Array.isArray(value)) return value.map(normalise).sort().join('|')
  return JSON.stringify(value)
}

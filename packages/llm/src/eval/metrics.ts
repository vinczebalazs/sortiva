/**
 * The two scorers the evaluation sets are graded on.
 *
 * *Distillation:* field-level F1 at or above 0.85, and **zero** fabricated field
 * values — any one of those is a hard fail no aggregate may absorb.
 * *Judge:* per-criterion mean absolute error at or below 0.5, **and** no draft that humans failed is
 * graded as passing (false-pass = hard fail)."
 *
 * Both hard-fail conditions are separate from the aggregate score on purpose: an
 * average can absorb a fabrication or a false pass, which is exactly the failure
 * mode the spec refuses to tolerate.
 *
 * What counts as a fabrication is therefore load-bearing in both directions. A
 * scorer that misses one lets a lie through; a scorer that reports one where
 * none happened turns the hard fail into noise, which ends the same way —
 * nobody reads it.
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
 * Field-level F1 over `field=value` claims. Comparing a field *with its value*
 * rather than the field name is what makes "said the material is leather when
 * it is nylon" a fabrication rather than a correctly-populated field.
 *
 * A fact sheet has two kinds of field: one answer (material, origin) or a list
 * of them (certifications, verifiable claims). A list is compared item by item,
 * so four right out of five is four hits and a miss — not, as it was until the
 * lists were joined into one string, a single whole fabrication. And an answer
 * a list did not give is nothing at all here: the model declining to answer is
 * a *miss*, never an invention, and reporting it as an invented value was the
 * scorer accusing the model of something it had not done.
 */
export function fieldF1(
  predicted: Readonly<Record<string, unknown>>,
  gold: Readonly<Record<string, unknown>>,
): F1Score {
  const predictedPairs = claims(predicted)
  const goldPairs = claims(gold)

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
  /** Per-criterion mean absolute error — the number the gate actually reads. */
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

/**
 * One sheet as a set of comparable claims: `field=value` for a single answer,
 * and one entry per item for a list field. A field with nothing in it — null,
 * blank, or an empty list — contributes no claim, because it asserts nothing.
 */
function claims(record: Readonly<Record<string, unknown>>): Set<string> {
  const out = new Set<string>()
  for (const [field, value] of Object.entries(record)) {
    for (const item of valuesOf(value)) out.add(`${field}=${item}`)
  }
  return out
}

function valuesOf(value: unknown): string[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value.flatMap(valuesOf)
  const text = normalise(value)
  return text === '' ? [] : [text]
}

/**
 * Case, surrounding space and **trailing punctuation** are not part of an
 * answer: "Wipe clean with a damp cloth." and "Wipe clean with a damp cloth"
 * are the same fact, and counting the full stop as an invented value is the
 * scorer inventing the problem. Only trailing punctuation goes — a full stop
 * inside a number ("1.9 kg") is part of the value.
 */
function normalise(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!]+$/, '')
    .trim()
}

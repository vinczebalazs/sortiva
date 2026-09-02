import type { CtrCurveConfig } from '@sortiva/rules'
import { isBrandedQuery } from './branded'

/**
 * How often this store's listings actually get clicked at each Google position.
 *
 * It exists to answer one question honestly: "this page ranks well — is it
 * getting the clicks it should?" Answering that against a published industry
 * table is close to meaningless for any single store, because the click rate at
 * a given position swings enormously with the device mix, how much of the
 * traffic is people searching the brand by name, and what else Google is putting
 * on the results page. So the comparison is against the store's own history.
 *
 * A store with too little history has nothing to fit, and a curve fitted from
 * almost no data is worse than a plain default because it looks specific to
 * them. In that case the fallback table is used and the row records that.
 */

/** One day's worth of one search on one page, as Search Console reports it. */
export interface CtrSampleRow {
  readonly query: string
  readonly position: number | null
  readonly clicks: number
  readonly impressions: number
}

/** Position (as a whole number) to the click rate we expect there. */
export type CtrCurve = Readonly<Record<string, number>>

export type CtrCurveSource = 'fitted' | 'standard'

/**
 * Why the store's own data was not used. Carried so that the merchant-facing
 * confidence penalty and the operator's log can both say which it was, rather
 * than reporting a bare "fell back".
 */
export type CtrCurveFallbackReason =
  | 'too_few_impressions'
  | 'too_few_positions'
  | 'no_downward_trend'

export interface CtrCurveFit {
  readonly curve: CtrCurve
  /** Impressions the fit was made from, after branded searches were removed. Stored as `ctr_curve.sample_n`. */
  readonly sampleN: number
  readonly brandedExcluded: boolean
  readonly source: CtrCurveSource
  readonly fallbackReason?: CtrCurveFallbackReason
}

export interface FitCtrCurveInput {
  readonly rows: readonly CtrSampleRow[]
  readonly config: CtrCurveConfig
  /** Words that mean somebody was searching for this store by name. Empty means we could not tell, and nothing is excluded. */
  readonly brandTokens?: readonly string[]
}

interface PositionBucket {
  clicks: number
  impressions: number
}

/**
 * Search Console reports an average position, so a row arrives as 3.4 rather
 * than as 3. Rounding to the nearest whole position is what makes the buckets
 * line up with the positions the curve is read at.
 */
function bucketOf(position: number, maxPosition: number): number | null {
  if (!Number.isFinite(position)) return null
  const rounded = Math.round(position)
  if (rounded < 1) return null
  if (rounded > maxPosition) return null
  return rounded
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * The plain fallback table, cut to the positions the curve describes. Read from
 * config rather than rebuilt, so there is exactly one place a fallback click
 * rate can come from.
 */
export function standardCurve(config: CtrCurveConfig): CtrCurve {
  const out: Record<string, number> = {}
  for (let position = 1; position <= config.max_position; position += 1) {
    const value = config.standard_curve[String(position)]
    // The loader refuses a config with a hole in this table, so a missing entry
    // here can only mean the config was bypassed. Failing is better than
    // silently reporting that nobody clicks at this position.
    if (typeof value !== 'number') {
      throw new Error(`the standard click curve has no entry for position ${position}`)
    }
    out[String(position)] = value
  }
  return out
}

/**
 * Fits `clicks ÷ impressions = a × position^(−b)`.
 *
 * A power law rather than a straight line because click rate falls away sharply
 * across the first few positions and then flattens, which a line cannot
 * describe: fitted straight, it would predict a negative click rate somewhere
 * down the first page. Taking logs of both sides turns it into a straight line
 * that ordinary least squares can solve.
 *
 * Each position is weighted by how many times the store was actually shown
 * there, so a position seen thirty thousand times counts thirty thousand times
 * more than one seen once. That is what makes a thin position harmless rather
 * than something needing its own floor to exclude it.
 */
function fitPowerLaw(
  buckets: ReadonlyMap<number, PositionBucket>,
): { scale: number; slope: number } | null {
  let sumW = 0
  let sumWx = 0
  let sumWy = 0
  let sumWxx = 0
  let sumWxy = 0

  for (const [position, bucket] of buckets) {
    if (!bucket.clicks) continue
    if (!bucket.impressions) continue
    const weight = bucket.impressions
    const x = Math.log(position)
    const y = Math.log(bucket.clicks / bucket.impressions)
    sumW += weight
    sumWx += weight * x
    sumWy += weight * y
    sumWxx += weight * x * x
    sumWxy += weight * x * y
  }

  if (!sumW) return null
  const denominator = sumW * sumWxx - sumWx * sumWx
  // Zero means every observation sits at the same position: one point, no line.
  if (denominator === 0) return null

  const slope = (sumW * sumWxy - sumWx * sumWy) / denominator
  const intercept = (sumWy - slope * sumWx) / sumW
  return { scale: Math.exp(intercept), slope }
}

export function fitCtrCurve(input: FitCtrCurveInput): CtrCurveFit {
  const { config } = input
  const tokens = input.brandTokens ?? []
  const brandedExcluded = tokens.length > 0

  const buckets = new Map<number, PositionBucket>()
  let sampleN = 0

  for (const row of input.rows) {
    if (!row.impressions) continue
    if (row.position === null) continue
    if (brandedExcluded && isBrandedQuery(row.query, tokens)) continue
    const bucket = bucketOf(row.position, config.max_position)
    if (bucket === null) continue
    const existing = buckets.get(bucket) ?? { clicks: 0, impressions: 0 }
    existing.clicks += row.clicks
    existing.impressions += row.impressions
    buckets.set(bucket, existing)
    sampleN += row.impressions
  }

  const fallback = (reason: CtrCurveFallbackReason): CtrCurveFit => ({
    curve: standardCurve(config),
    sampleN,
    brandedExcluded,
    source: 'standard',
    fallbackReason: reason,
  })

  if (sampleN < config.min_sample_impressions) return fallback('too_few_impressions')

  const observed = [...buckets.values()].filter((bucket) => bucket.clicks && bucket.impressions)
  if (observed.length < config.min_position_buckets) return fallback('too_few_positions')

  const fit = fitPowerLaw(buckets)
  if (!fit) return fallback('too_few_positions')
  // A curve that says clicks get *more* likely further down the page is not a
  // description of this store, it is a description of noise in its data.
  if (fit.slope >= 0) return fallback('no_downward_trend')

  const curve: Record<string, number> = {}
  for (let position = 1; position <= config.max_position; position += 1) {
    const predicted = fit.scale * Math.pow(position, fit.slope)
    curve[String(position)] = clamp(predicted, config.fitted_ctr_min, config.fitted_ctr_max)
  }

  return { curve, sampleN, brandedExcluded, source: 'fitted' }
}

/**
 * The click rate the curve expects at a position, for a position Search Console
 * reported as a fraction. Anything past the end of the curve is answered with
 * the curve's last position: further down, the difference stopped mattering
 * long before the arithmetic did.
 */
export function expectedCtrAt(curve: CtrCurve, position: number): number | null {
  if (!Number.isFinite(position)) return null
  const rounded = Math.max(1, Math.round(position))
  const direct = curve[String(rounded)]
  if (typeof direct === 'number') return direct
  const positions = Object.keys(curve)
    .map(Number)
    .filter((value) => Number.isFinite(value))
  if (positions.length === 0) return null
  const last = Math.max(...positions)
  const tail = curve[String(last)]
  return typeof tail === 'number' ? tail : null
}

import type { MarkerKind, PerformanceDay, PerformanceMarker } from './types'

/**
 * The geometry behind the search-performance chart: where each day sits, where
 * the line breaks, and where the things we did are drawn across it.
 *
 * It is arithmetic in its own file rather than JSX for two reasons. The rule
 * that a missing day is drawn as a hole and never joined across is the whole
 * point of the chart and has to be provable without a browser; and the same
 * geometry draws the full-width chart on Performance and the compact one on the
 * dashboard, at different sizes, from one set of rules.
 *
 * **Clicks and impressions are two panels, not two lines on one plot.** A store
 * with forty clicks and two thousand impressions cannot show both against one
 * vertical scale, and the alternative — a second axis on the right — makes the
 * gap between the lines look like a finding when it is an artefact of where the
 * two scales were pinned. Two panels stacked over one shared row of dates keep
 * every comparison the merchant can make an honest one.
 */

export interface ChartBox {
  readonly width: number
  /** One panel's plot height. Two panels are stacked, so the SVG is taller than this. */
  readonly height: number
}

export interface PlottedPoint {
  readonly date: string
  readonly value: number
  readonly x: number
  readonly y: number
}

/**
 * A stretch of days we have data for. Days without data separate one run from
 * the next; a run holding a single day has no line to draw and renders as a
 * lone dot, which is honest about there being nothing either side of it.
 */
export interface Run {
  readonly points: readonly PlottedPoint[]
  readonly path: string
}

export interface Panel {
  /** `clicks` or `impressions` — which measure this panel plots. */
  readonly measure: 'clicks' | 'impressions'
  readonly runs: readonly Run[]
  /** The top of this panel's scale, rounded up to something a person would say. */
  readonly max: number
  /** Rounded tick values, largest first, for the panel's own axis. */
  readonly ticks: readonly number[]
  /** Days in range with no figure at all, which is what the gap note counts. */
  readonly missingDays: number
  /** The last day we have a figure for, direct-labelled at the line's end. */
  readonly last: PlottedPoint | null
}

export interface PlottedMarker extends PerformanceMarker {
  readonly x: number
  /** True when two markers land close enough that only one of them can carry a label. */
  readonly labelled: boolean
}

export interface ChartGeometry {
  readonly box: ChartBox
  readonly panels: readonly Panel[]
  readonly markers: readonly PlottedMarker[]
  /** Sparse date labels along the shared bottom axis. */
  readonly dateTicks: readonly { readonly date: string; readonly x: number }[]
  /** False when there is nothing to draw, so the caller shows a note instead of an empty frame. */
  readonly hasData: boolean
}

/** Drawing order, so the legend and the marker rules always agree. */
export const MARKER_KINDS: readonly MarkerKind[] = [
  'gsc_connected',
  'article_published',
  'optimize_applied',
]

/**
 * How wide a marker's label is, when nobody has measured it.
 *
 * Labels are dropped rather than stacked when two would overlap, and working
 * out whether they overlap means knowing how wide each one is. There is no way
 * to measure text without a browser, so the caller — which has the translated
 * words — estimates from their length, and this is what a caller that does not
 * bother gets. A store publishing daily would otherwise turn the foot of the
 * chart into a wall of overlapping text; the rules themselves all stay and the
 * key below the chart still names every kind, so nothing is hidden.
 */
const DEFAULT_LABEL_WIDTH = 120

/** Clear space between two labels before they read as one run of words. */
const LABEL_GUTTER_PX = 12

function niceMax(value: number): number {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude
    if (candidate >= value) return candidate
  }
  return 10 * magnitude
}

function ticksFor(max: number): readonly number[] {
  return [max, max * 0.75, max * 0.5, max * 0.25, 0].map((value) =>
    Number.isInteger(value) ? value : Math.round(value),
  )
}

function xOf(index: number, count: number, width: number): number {
  if (count <= 1) return width / 2
  return round((index / (count - 1)) * width)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function buildPanel(
  measure: 'clicks' | 'impressions',
  series: readonly PerformanceDay[],
  box: ChartBox,
): Panel {
  const values = series.map((day) => (measure === 'clicks' ? day.clicks : day.impressions))
  const present = values.filter((value): value is number => value !== null)
  const max = niceMax(present.length > 0 ? Math.max(...present) : 0)

  const runs: Run[] = []
  let current: PlottedPoint[] = []

  const close = () => {
    if (current.length === 0) return
    runs.push({ points: current, path: pathOf(current) })
    current = []
  }

  series.forEach((day, index) => {
    const value = values[index]
    if (value === null || value === undefined) {
      close()
      return
    }
    current.push({
      date: day.date,
      value,
      x: xOf(index, series.length, box.width),
      // A zero sits on the floor of the panel and a maximum at its ceiling.
      y: round(box.height - (value / max) * box.height),
    })
  })
  close()

  const lastRun = runs[runs.length - 1]
  return {
    measure,
    runs,
    max,
    ticks: ticksFor(max),
    missingDays: values.filter((value) => value === null).length,
    last: lastRun ? (lastRun.points[lastRun.points.length - 1] ?? null) : null,
  }
}

function pathOf(points: readonly PlottedPoint[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join(' ')
}

/**
 * How close two date labels may sit before the second is dropped. A date is
 * about sixty pixels wide at the size these are set, and two overlapping dates
 * are worse than one date and a gap.
 */
const DATE_CLEARANCE_PX = 84

/**
 * Roughly five date labels along the bottom, whatever the range: enough to place
 * a marker in time, few enough that they never collide.
 *
 * The last day always gets a label — it is the one the merchant is looking at —
 * and if the evenly spaced tick before it lands too close, that one goes rather
 * than the last day.
 */
function dateTicksFor(series: readonly PerformanceDay[], width: number) {
  if (series.length === 0) return []
  const wanted = Math.min(5, series.length)
  const step = Math.max(1, Math.floor((series.length - 1) / Math.max(1, wanted - 1)))
  const ticks: { date: string; x: number }[] = []
  for (let index = 0; index < series.length; index += step) {
    ticks.push({ date: series[index]!.date, x: xOf(index, series.length, width) })
  }
  const lastIndex = series.length - 1
  const last = { date: series[lastIndex]!.date, x: xOf(lastIndex, series.length, width) }
  if (ticks[ticks.length - 1]?.date !== last.date) {
    while (ticks.length > 1 && last.x - ticks[ticks.length - 1]!.x < DATE_CLEARANCE_PX) ticks.pop()
    ticks.push(last)
  }
  return ticks
}

/**
 * How a label at this position has to be anchored to stay inside the drawing.
 *
 * A label centred on the first or last day would hang half of itself off the
 * edge of the card, which in a chart that scales to its container means the
 * date is simply cut in half.
 */
export function labelAnchor(x: number, width: number): 'start' | 'middle' | 'end' {
  if (x <= width * 0.04) return 'start'
  if (x >= width * 0.96) return 'end'
  return 'middle'
}

/**
 * Where a marker's date falls on the chart.
 *
 * A marker for a day outside the range is dropped rather than clamped to an
 * edge: an article published before Search Console was connected did not happen
 * on the first day of the chart, and pinning it there would invite the merchant
 * to read a rise that predates it as its doing.
 */
function plotMarkers(
  markers: readonly PerformanceMarker[],
  series: readonly PerformanceDay[],
  width: number,
  labelWidthOf: (kind: MarkerKind) => number,
): readonly PlottedMarker[] {
  const index = new Map(series.map((day, position) => [day.date, position]))
  const placed = markers
    .map((marker) => {
      const position = index.get(marker.date)
      if (position === undefined) return null
      return { ...marker, x: xOf(position, series.length, width), labelled: true }
    })
    .filter((marker): marker is PlottedMarker => marker !== null)
    .sort((left, right) => left.x - right.x)

  // The right edge of the last label that was kept. A label is kept only when
  // its own left edge clears it — comparing the marker positions instead would
  // let a long label run into a short one sitting just past the threshold.
  let occupiedTo = Number.NEGATIVE_INFINITY
  return placed.map((marker) => {
    const [left, right] = labelSpan(marker.x, width, labelWidthOf(marker.kind))
    const labelled = left >= occupiedTo + LABEL_GUTTER_PX
    if (labelled) occupiedTo = right
    return { ...marker, labelled }
  })
}

/** Where a label of this width actually sits, given how its position anchors it. */
function labelSpan(x: number, width: number, labelWidth: number): [number, number] {
  const anchor = labelAnchor(x, width)
  if (anchor === 'start') return [x, x + labelWidth]
  if (anchor === 'end') return [x - labelWidth, x]
  return [x - labelWidth / 2, x + labelWidth / 2]
}

export function chartGeometry(
  series: readonly PerformanceDay[],
  markers: readonly PerformanceMarker[],
  box: ChartBox,
  /** How wide each kind's label renders, so overlapping ones can be dropped. */
  labelWidthOf: (kind: MarkerKind) => number = () => DEFAULT_LABEL_WIDTH,
): ChartGeometry {
  const ordered = [...series].sort((left, right) => left.date.localeCompare(right.date))
  return {
    box,
    panels: [
      buildPanel('clicks', ordered, box),
      buildPanel('impressions', ordered, box),
    ],
    markers: plotMarkers(markers, ordered, box.width, labelWidthOf),
    dateTicks: dateTicksFor(ordered, box.width),
    hasData: ordered.some((day) => day.clicks !== null || day.impressions !== null),
  }
}

/** The total over the days we actually have, and how many we did not have. */
export interface MeasureTotal {
  readonly total: number
  readonly missingDays: number
}

/**
 * Totals are summed over the days that reported, and the count of days that did
 * not is carried alongside rather than folded in. A total that quietly treats a
 * missing day as a nought is a smaller number presented as a complete one.
 */
export function measureTotal(
  series: readonly PerformanceDay[],
  measure: 'clicks' | 'impressions',
): MeasureTotal {
  let total = 0
  let missingDays = 0
  for (const day of series) {
    const value = measure === 'clicks' ? day.clicks : day.impressions
    if (value === null) missingDays += 1
    else total += value
  }
  return { total, missingDays }
}

import { t as defaultTranslate, type Translate } from '../strings'
import { formatDate } from '../opportunities/list'
import { chartGeometry, measureTotal, MARKER_KINDS, type ChartBox } from './chart'
import { formatCount, markerLabel } from './performance'
import type { PerformanceDay, PerformanceMarker } from './types'

/**
 * Search performance since Search Console was connected, with the things we did
 * drawn across it.
 *
 * Clicks and impressions get a panel each over one shared row of dates. They
 * are not two lines on one plot: a store with forty clicks and two thousand
 * impressions has no single vertical scale that shows both, and a second axis
 * on the right would make the distance between the lines look like a finding
 * when it is only where the two scales were pinned.
 *
 * **A day Search Console never reported is a hole in the line.** The line stops
 * and starts again on the far side of it, and the note under the chart says so.
 * Joining across would invent traffic on a day nobody measured, and the invented
 * stretch would be indistinguishable from a measured one.
 *
 * The lines are ink and the markers carry the colour, which is the right way
 * round: the question this chart answers is whether what we did moved anything,
 * so the things we did are what the eye should find first. The three marker
 * colours were checked for colour-blind separation rather than chosen by eye,
 * and each also differs in dash pattern and carries its date, so none of them
 * depends on colour alone.
 */

const DEFAULT_BOX: ChartBox = { width: 880, height: 96 }

/** Room under the two panels for the shared date row and the marker labels. */
const AXIS_HEIGHT = 46
const PANEL_GAP = 34

export interface PerformanceChartProps {
  readonly series: readonly PerformanceDay[]
  readonly markers: readonly PerformanceMarker[]
  readonly t?: Translate
  readonly box?: ChartBox
  /** The compact dashboard copy drops the marker labels and the y-axis figures. */
  readonly compact?: boolean
}

export function PerformanceChart({
  series,
  markers,
  t = defaultTranslate,
  box = DEFAULT_BOX,
  compact = false,
}: PerformanceChartProps) {
  const geometry = chartGeometry(series, markers, box)
  const totalHeight = box.height * 2 + PANEL_GAP + AXIS_HEIGHT
  const missingDays = geometry.panels[0]?.missingDays ?? 0

  if (!geometry.hasData) {
    return (
      <p className="sortiva-perf__chart-empty" data-perf-chart="empty">
        {t('performance.chart.noData')}
      </p>
    )
  }

  return (
    <figure className="sortiva-perf__chart" data-perf-chart="drawn">
      <svg
        viewBox={`0 0 ${box.width} ${totalHeight}`}
        role="img"
        aria-label={t('performance.chart.alt')}
        className="sortiva-perf__svg"
        preserveAspectRatio="none"
      >
        {geometry.panels.map((panel, index) => {
          const top = index * (box.height + PANEL_GAP)
          return (
            <g key={panel.measure} transform={`translate(0 ${top})`} data-perf-panel={panel.measure}>
              {panel.ticks.map((tick) => (
                <line
                  key={tick}
                  x1={0}
                  x2={box.width}
                  y1={box.height - (tick / panel.max) * box.height}
                  y2={box.height - (tick / panel.max) * box.height}
                  className="sortiva-perf__grid"
                />
              ))}

              {geometry.markers.map((marker) => (
                <line
                  key={`${marker.kind}-${marker.date}`}
                  x1={marker.x}
                  x2={marker.x}
                  y1={0}
                  y2={box.height}
                  className="sortiva-perf__marker-rule"
                  data-perf-marker={marker.kind}
                />
              ))}

              {panel.runs.map((run) =>
                run.points.length === 1 ? (
                  <circle
                    key={run.path}
                    cx={run.points[0]!.x}
                    cy={run.points[0]!.y}
                    r={3}
                    className="sortiva-perf__lone-point"
                  />
                ) : (
                  <path key={run.path} d={run.path} className="sortiva-perf__line" />
                ),
              )}

              {panel.last ? (
                <circle
                  cx={panel.last.x}
                  cy={panel.last.y}
                  r={4}
                  className="sortiva-perf__end-dot"
                />
              ) : null}

              {compact ? null : (
                <text x={0} y={-8} className="sortiva-perf__panel-title">
                  {t(
                    panel.measure === 'clicks'
                      ? 'performance.measure.clicks'
                      : 'performance.measure.impressions',
                  )}
                </text>
              )}
              {compact ? null : (
                <text x={box.width} y={-8} textAnchor="end" className="sortiva-perf__panel-max">
                  {t('performance.chart.peak', { value: formatCount(panel.max) })}
                </text>
              )}
            </g>
          )
        })}

        <g transform={`translate(0 ${box.height * 2 + PANEL_GAP})`}>
          {geometry.dateTicks.map((tick) => (
            <text key={tick.date} x={tick.x} y={14} className="sortiva-perf__date" textAnchor="middle">
              {formatDate(tick.date)}
            </text>
          ))}
          {compact
            ? null
            : geometry.markers
                .filter((marker) => marker.labelled)
                .map((marker) => (
                  <text
                    key={`${marker.kind}-${marker.date}`}
                    x={marker.x}
                    y={32}
                    textAnchor="middle"
                    className="sortiva-perf__marker-label"
                    data-perf-marker-label={marker.kind}
                  >
                    {markerLabel(marker.kind, t)}
                  </text>
                ))}
        </g>
      </svg>

      <ChartLegend markers={markers} t={t} />

      <figcaption className="sortiva-perf__note" data-perf-lag-note>
        {t('performance.chart.lagNote')}
        {missingDays > 0 ? ` ${t('performance.chart.gapNote', { days: missingDays })}` : ''}
      </figcaption>

      <ChartTable series={series} t={t} />
    </figure>
  )
}

/**
 * The marker key. Present whenever there are markers at all: the rules on the
 * chart are the argument it makes, and a merchant who cannot tell a publish
 * date from an applied recommendation cannot read the argument.
 */
function ChartLegend({ markers, t }: { markers: readonly PerformanceMarker[]; t: Translate }) {
  const kinds = MARKER_KINDS.filter((kind) => markers.some((marker) => marker.kind === kind))
  if (kinds.length === 0) return null

  return (
    <ul className="sortiva-perf__legend" data-perf-legend>
      {kinds.map((kind) => (
        <li key={kind} data-perf-legend-item={kind}>
          <span className="sortiva-perf__legend-key" data-perf-marker={kind} aria-hidden="true" />
          {markerLabel(kind, t)}
        </li>
      ))}
    </ul>
  )
}

/**
 * The same figures as a table, folded away.
 *
 * A chart is a picture, and a picture is unreadable to a screen reader and
 * imprecise to anyone who wants the actual number for a day. The table is the
 * chart's own data rather than a second read, so the two cannot disagree — and
 * a day with no figure shows the same absence here as it does there.
 */
function ChartTable({ series, t }: { series: readonly PerformanceDay[]; t: Translate }) {
  const clicks = measureTotal(series, 'clicks')
  const impressions = measureTotal(series, 'impressions')

  return (
    <details className="sortiva-perf__table-toggle" data-perf-chart-table>
      <summary>{t('performance.chart.showTable')}</summary>
      <p className="sortiva-perf__totals">
        {t('performance.chart.totals', {
          clicks: formatCount(clicks.total),
          impressions: formatCount(impressions.total),
        })}
      </p>
      <table>
        <thead>
          <tr>
            <th>{t('performance.chart.col.date')}</th>
            <th>{t('performance.measure.clicks')}</th>
            <th>{t('performance.measure.impressions')}</th>
          </tr>
        </thead>
        <tbody>
          {series.map((day) => (
            <tr key={day.date} data-perf-day={day.date}>
              <td>{formatDate(day.date)}</td>
              <td>{day.clicks === null ? t('performance.noFigure') : formatCount(day.clicks)}</td>
              <td>
                {day.impressions === null ? t('performance.noFigure') : formatCount(day.impressions)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}

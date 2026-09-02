import { t as defaultTranslate, type Translate } from '../strings'
import {
  formatCount,
  formatPosition,
  isUnmeasured,
  labelTone,
  resultFigure,
  resultLabel,
} from './performance'
import type { PerformanceResult } from './types'

/**
 * Every article we published and every store page whose improvement was
 * applied, with what happened to it.
 *
 * The one thing this table must get right is the difference between a page that
 * did badly and a page nobody has judged yet. A result younger than the
 * measurement window has **no figures at all** — dashes, not noughts — and its
 * chip says it is too new. A nought in the clicks column would be read as a page
 * nobody visited, which is a verdict, and delivering a verdict early is exactly
 * what the measurement window exists to prevent.
 *
 * The verdicts themselves are relative to this store's own median rather than to
 * any absolute number: thirty clicks a month is a triumph for one catalogue and
 * a disappointment for another, and the note under the table says so.
 */

export interface ResultsTableProps {
  readonly results: readonly PerformanceResult[]
  readonly t?: Translate
  readonly articleHref?: (articleId: string) => string
}

export function ResultsTable({
  results,
  t = defaultTranslate,
  articleHref = (id) => `/content/articles/${id}`,
}: ResultsTableProps) {
  if (results.length === 0) {
    return (
      <p className="sortiva-perf__empty" data-perf-results="empty">
        {t('performance.results.empty')}
      </p>
    )
  }

  return (
    <table className="sortiva-perf__results" data-perf-results="rows">
      <thead>
        <tr>
          <th>{t('performance.results.col.subject')}</th>
          <th>{t('performance.measure.clicks')}</th>
          <th>{t('performance.measure.impressions')}</th>
          <th>{t('performance.measure.position')}</th>
          <th>{t('performance.results.col.label')}</th>
        </tr>
      </thead>
      <tbody>
        {results.map((result) => (
          <ResultRow key={`${result.kind}-${result.id}`} result={result} t={t} articleHref={articleHref} />
        ))}
      </tbody>
    </table>
  )
}

function ResultRow({
  result,
  t,
  articleHref,
}: {
  result: PerformanceResult
  t: Translate
  articleHref: (articleId: string) => string
}) {
  const unmeasured = isUnmeasured(result.label)
  const clicks = resultFigure(result, 'clicks')
  const impressions = resultFigure(result, 'impressions')
  const position = resultFigure(result, 'position')

  return (
    <tr
      data-perf-result={result.id}
      data-perf-result-kind={result.kind}
      data-perf-result-label={result.label}
      data-perf-result-measured={unmeasured ? 'false' : 'true'}
    >
      <td>
        {result.kind === 'article' ? (
          <a href={articleHref(result.id)}>{result.title}</a>
        ) : (
          <span>{result.title}</span>
        )}
      </td>
      <td data-perf-cell="clicks">{clicks === null ? t('performance.noFigure') : formatCount(clicks)}</td>
      <td data-perf-cell="impressions">
        {impressions === null ? t('performance.noFigure') : formatCount(impressions)}
      </td>
      <td data-perf-cell="position">
        {position === null ? t('performance.noFigure') : formatPosition(position)}
        {position === null ? null : <TrendArrow trend={result.trend} t={t} />}
      </td>
      <td>
        <span
          className="sortiva-perf__chip"
          data-perf-label={result.label}
          data-perf-tone={labelTone(result.label)}
        >
          {resultLabel(result.label, t)}
        </span>
      </td>
    </tr>
  )
}

/**
 * A direction, in a word as well as a shape. An arrow alone would be invisible
 * to a screen reader and ambiguous in print.
 */
function TrendArrow({ trend, t }: { trend: PerformanceResult['trend']; t: Translate }) {
  if (trend === 'flat') return null
  return (
    <span className="sortiva-perf__trend" data-perf-trend={trend}>
      <span aria-hidden="true">{trend === 'up' ? '▲' : '▼'}</span>
      <span className="sortiva-visually-hidden">
        {t(trend === 'up' ? 'performance.trend.up' : 'performance.trend.down')}
      </span>
    </span>
  )
}

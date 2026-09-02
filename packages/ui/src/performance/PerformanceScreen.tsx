import { t as defaultTranslate, type Translate } from '../strings'
import { formatDate } from '../opportunities/list'
import { ConnectSearchConsoleCard } from './ConnectSearchConsoleCard'
import { PerformanceChart } from './PerformanceChart'
import { ResultsTable } from './ResultsTable'
import { measureTotal } from './chart'
import { formatCount, labelCounts, resultLabel, splitResults } from './performance'
import type { PerformanceOverview } from './types'

/**
 * Performance — what the store's search traffic has done since we could see it,
 * and what happened to each thing we published or improved.
 *
 * Three things on this screen are load-bearing.
 *
 * **Nothing here is a count against a target.** There is no "22 of 30", no
 * progress bar towards a monthly number, and no ratio of articles attributed to
 * articles published. One article a day is a ceiling the quality bar may stop us
 * reaching, and a screen that showed progress towards it would be promising a
 * number the product deliberately does not promise.
 *
 * **A result with no verdict yet is shown as early, never as nought.** The
 * results table renders dashes and a "too new to judge" chip for anything inside
 * the measurement window.
 *
 * **Articles published against our recommendation sit in their own folded-away
 * section.** They are excluded from quality tuning and from any claim about how
 * our writing performs, so they may not sit in the same list as the results we
 * do learn from.
 */

export interface PerformanceScreenProps {
  readonly data: PerformanceOverview
  readonly t?: Translate
  /** When Search Console was connected, for the subtitle. */
  readonly connectedAt?: string | null
  readonly connectHref?: string
  readonly articleHref?: (articleId: string) => string
}

export function PerformanceScreen({
  data,
  t = defaultTranslate,
  connectedAt = null,
  connectHref = '/settings/connections',
  articleHref,
}: PerformanceScreenProps) {
  if (!data.connected) {
    return (
      <section className="sortiva-perf" data-perf-state="not_connected">
        <h1>{t('performance.heading')}</h1>
        <ConnectSearchConsoleCard t={t} connectHref={connectHref} />
      </section>
    )
  }

  const { rows, overridden } = splitResults(data.results)
  const clicks = measureTotal(data.series, 'clicks')
  const impressions = measureTotal(data.series, 'impressions')
  const counts = labelCounts(rows)
  const connectionDate =
    connectedAt ?? data.markers.find((marker) => marker.kind === 'gsc_connected')?.date ?? null

  return (
    <section className="sortiva-perf" data-perf-state="connected">
      <header className="sortiva-perf__head">
        <h1>{t('performance.heading')}</h1>
        <p className="sortiva-perf__since">
          {connectionDate
            ? t('performance.since', { date: formatDate(connectionDate) })
            : t('performance.sinceUnknown')}
        </p>
      </header>

      <div className="sortiva-perf__totals-row" data-perf-totals>
        <Figure label={t('performance.measure.clicks')} value={formatCount(clicks.total)} />
        <Figure label={t('performance.measure.impressions')} value={formatCount(impressions.total)} />
        {clicks.missingDays > 0 ? (
          <p className="sortiva-perf__missing" data-perf-missing-days>
            {t('performance.missingDays', { days: clicks.missingDays })}
          </p>
        ) : null}
      </div>

      <PerformanceChart series={data.series} markers={data.markers} t={t} />

      <section className="sortiva-perf__section" data-perf-section="results">
        <h2>{t('performance.results.heading')}</h2>
        <p className="sortiva-perf__note">{t('performance.results.window')}</p>
        <ResultsTable results={rows} t={t} {...(articleHref ? { articleHref } : {})} />
        <p className="sortiva-perf__note" data-perf-relative-note>
          {t('performance.results.relativeNote')}
        </p>
      </section>

      {Object.keys(counts).length > 0 ? (
        <section className="sortiva-perf__section" data-perf-section="labels">
          <h2>{t('performance.labels.heading')}</h2>
          <p className="sortiva-perf__note">{t('performance.labels.subtitle')}</p>
          <ul className="sortiva-perf__label-counts">
            {Object.entries(counts).map(([label, count]) => (
              <li key={label} data-perf-label-count={label}>
                <span>{resultLabel(label, t)}</span>
                <span className="sortiva-perf__label-figure">{formatCount(count)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {overridden.length > 0 ? (
        <details className="sortiva-perf__overridden" data-perf-overridden>
          <summary>
            {t('performance.overridden.heading', { count: overridden.length })}
          </summary>
          <p className="sortiva-perf__note">{t('performance.overridden.note')}</p>
          <ResultsTable results={overridden} t={t} {...(articleHref ? { articleHref } : {})} />
        </details>
      ) : null}
    </section>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="sortiva-perf__figure">
      <p className="sortiva-perf__figure-label">{label}</p>
      <p className="sortiva-perf__figure-value">{value}</p>
    </div>
  )
}

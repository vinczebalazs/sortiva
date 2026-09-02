import { t as defaultTranslate, type Translate } from '../strings'

/**
 * What Performance is before Search Console is connected, and what the dashboard
 * shows in place of its chart.
 *
 * The heading is one of the sentences the product may not reword, and a
 * snapshot holds it exact. The line under it is the reason a merchant would
 * bother: this is not a reporting add-on, it is the data the whole engine reads
 * before it decides anything.
 */

export interface ConnectSearchConsoleCardProps {
  readonly t?: Translate
  readonly connectHref?: string
  /** The dashboard shows the same card at the size of one panel. */
  readonly compact?: boolean
}

export function ConnectSearchConsoleCard({
  t = defaultTranslate,
  connectHref = '/settings/connections',
  compact = false,
}: ConnectSearchConsoleCardProps) {
  return (
    <section className="sortiva-perf__connect" data-perf-connect data-compact={compact ? 'true' : 'false'}>
      <h2>{t('appendixA.gscConnect')}</h2>
      <p>{t('performance.connect.value')}</p>
      {compact ? null : <p className="sortiva-perf__connect-note">{t('performance.connect.note')}</p>}
      <a className="sortiva-perf__connect-action" href={connectHref} data-perf-connect-action>
        {t('performance.connect.action')}
      </a>
    </section>
  )
}

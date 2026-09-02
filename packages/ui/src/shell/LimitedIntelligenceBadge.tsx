import { t as defaultTranslate, type Translate } from '../strings'
import { InfoIcon } from './icons'

/**
 * Shown wherever conclusions are drawn without Search Console data — the
 * Opportunities header and the dashboard headline. It is deliberately not a
 * blocker: the product still works, and the badge says exactly what is missing
 * and offers the way to fix it.
 */

export interface LimitedIntelligenceBadgeProps {
  readonly t?: Translate
  /**
   * The signal types not evaluated without Search Console, already turned into
   * display names by the caller. Listed under the badge so "limited" is a
   * specific claim rather than a vague one.
   */
  readonly unavailableSignals?: readonly string[]
  readonly connectHref?: string
  /** The compact form for a header, without the sentence. */
  readonly compact?: boolean
}

export function LimitedIntelligenceBadge({
  t = defaultTranslate,
  unavailableSignals = [],
  connectHref = '/settings/connections',
  compact = false,
}: LimitedIntelligenceBadgeProps) {
  return (
    <div className="sortiva-limited" data-testid="limited-intelligence-badge">
      <span className="sortiva-limited__badge">
        <InfoIcon />
        <span className="sortiva-limited__label">{t('badge.limitedIntelligence')}</span>
      </span>
      {compact ? null : (
        <p className="sortiva-limited__message">
          {t('appendixA.limitedModeBadge')}{' '}
          <a className="sortiva-limited__connect" href={connectHref}>
            {t('banner.limitedIntelligence.action')}
          </a>
        </p>
      )}
      {unavailableSignals.length > 0 ? (
        <details className="sortiva-limited__signals">
          <summary>{t('badge.limitedIntelligence.unavailableHeading')}</summary>
          <ul>
            {unavailableSignals.map((signal) => (
              <li key={signal}>{signal}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  )
}

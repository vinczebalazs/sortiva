import { t as defaultTranslate, type Translate } from '../strings'
import { signalLabel } from '../opportunities/list'
import {
  clicksDelta,
  formatCount,
  formatCtr,
  formatPosition,
  pageTypeLabel,
  positionDelta,
  signalBadges,
} from './performance'
import type { SearchConsoleDimension, SearchConsoleRow } from './types'

/**
 * The queries a store is found for, and the pages that answer them.
 *
 * Everybody ships this table; it earns its place here only because of the last
 * column. **Where a row has an open opportunity, the signal is a link into it** —
 * so a merchant reading "position 8.6, click-through 2.4%" is one click from the
 * scored recommendation about it rather than left to work out what to do. A row
 * you can act on is worth more than a row you can read, and without the badges
 * this would be a reporting island.
 *
 * The address a badge points at is the one the calendar already uses for the
 * same purpose, so both surfaces reach an opportunity the same way.
 */

export interface SearchConsoleTableProps {
  readonly rows: readonly SearchConsoleRow[]
  readonly dimension: SearchConsoleDimension
  readonly t?: Translate
  readonly opportunitiesHref?: string
  /** Fired when a badge is followed, so the screen can report the click. */
  readonly onSignalFollowed?: (row: SearchConsoleRow, opportunityId: string) => void
}

export function SearchConsoleTable({
  rows,
  dimension,
  t = defaultTranslate,
  opportunitiesHref = '/opportunities',
  onSignalFollowed,
}: SearchConsoleTableProps) {
  if (rows.length === 0) {
    return (
      <p className="sortiva-perf__empty" data-sc-table={`${dimension}-empty`}>
        {t('performance.searchConsole.empty')}
      </p>
    )
  }

  return (
    <table className="sortiva-perf__sc-table" data-sc-table={dimension}>
      <thead>
        <tr>
          <th>
            {t(
              dimension === 'query'
                ? 'performance.searchConsole.col.query'
                : 'performance.searchConsole.col.page',
            )}
          </th>
          {dimension === 'page' ? <th>{t('performance.searchConsole.col.pageType')}</th> : null}
          <th>{t('performance.measure.clicks')}</th>
          <th>{t('performance.measure.impressions')}</th>
          <th>{t('performance.measure.ctr')}</th>
          <th>{t('performance.measure.position')}</th>
          <th>{t('performance.searchConsole.col.signal')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const clicks = clicksDelta(row.deltaClicks, t)
          const position = positionDelta(row.deltaPosition, t)
          const badges = signalBadges(row, opportunitiesHref)

          return (
            <tr key={`${dimension}-${row.key}`} data-sc-row={row.key}>
              <td className="sortiva-perf__sc-key">{row.key}</td>
              {dimension === 'page' ? (
                <td>
                  {row.pageType ? (
                    <span className="sortiva-perf__chip" data-sc-page-type={row.pageType}>
                      {pageTypeLabel(row.pageType, t)}
                    </span>
                  ) : (
                    t('performance.noFigure')
                  )}
                </td>
              ) : null}
              <td>
                {formatCount(row.clicks)}
                <span
                  className="sortiva-perf__delta"
                  data-sc-delta="clicks"
                  data-sc-delta-direction={clicks.direction}
                >
                  {clicks.text}
                </span>
              </td>
              <td>{formatCount(row.impressions)}</td>
              <td>{formatCtr(row.ctr)}</td>
              <td>
                {formatPosition(row.position)}
                <span
                  className="sortiva-perf__delta"
                  data-sc-delta="position"
                  data-sc-delta-direction={position.direction}
                >
                  {position.text}
                </span>
              </td>
              <td>
                {badges.length === 0 ? (
                  <span className="sortiva-perf__no-signal">{t('performance.noFigure')}</span>
                ) : (
                  badges.map((badge) => (
                    <a
                      key={badge.opportunityId}
                      className="sortiva-perf__signal"
                      href={badge.href}
                      data-sc-signal={badge.signalType}
                      data-sc-signal-opportunity={badge.opportunityId}
                      onClick={
                        onSignalFollowed
                          ? () => onSignalFollowed(row, badge.opportunityId)
                          : undefined
                      }
                    >
                      {signalLabel(badge.signalType, t)}
                    </a>
                  ))
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

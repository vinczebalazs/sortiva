'use client'

import { useState } from 'react'
import { t as defaultTranslate, type StringKey, type Translate } from '../strings'
import { OpportunityCard } from './OpportunityCard'
import {
  ACTION_ORDER,
  DEFAULT_FILTERS,
  ENTITY_ORDER,
  GSC_DEPENDENT_SIGNALS,
  IMPACT_ORDER,
  STATUS_ORDER,
  actionLabel,
  entityLabel,
  groupByAction,
  impactLabel,
  matchesFilters,
  scanLine,
  signalLabel,
  signalTypesIn,
  sortOpportunities,
  statusLabel,
  toggleFilter,
  type OpportunityFilters,
  type PrimaryAction,
  type PrimaryActionContext,
  type SortKey,
} from './list'
import type { OpportunityListResponse, OpportunityRow } from './types'

/**
 * The whole list of what a merchant could do about their store, with the
 * controls that narrow it.
 *
 * Two things about the shape are deliberate. The header above this — the
 * headline count, the Limited Intelligence badge and the one-time explainer of
 * the four action types — belongs to the activation moment and is rendered by
 * the page, so nothing here repeats it; what this adds under Limited
 * Intelligence is the list of checks that are not running, which is the part
 * that makes "limited" a specific claim rather than a mood.
 *
 * And the filters live in this component rather than in the address bar. They
 * are a way of reading one screenful, not a place to return to, and putting
 * them in the URL would make every chip a navigation the back button has to
 * unwind.
 */

const SORTS: readonly SortKey[] = ['impact', 'confidence', 'newest']

export interface OpportunityListProps {
  readonly data: OpportunityListResponse
  readonly t?: Translate
  /** Overrides for the opening state, so a test and a deep link can both set one. */
  readonly initialFilters?: OpportunityFilters
  readonly initialSort?: SortKey
  readonly initialGrouped?: boolean
  readonly context?: PrimaryActionContext
  readonly onPrimary?: (opportunity: OpportunityRow, action: PrimaryAction) => void
  readonly onDismiss?: (opportunity: OpportunityRow) => void
  readonly onDetails?: (opportunity: OpportunityRow) => void
  /** Ids whose own request is in flight, so their buttons cannot be pressed twice. */
  readonly busyIds?: readonly string[]
}

interface ChipRowProps {
  readonly facet: keyof OpportunityFilters
  readonly labelKey: StringKey
  readonly values: readonly string[]
  readonly selected: readonly string[]
  readonly label: (value: string) => string
  readonly count?: (value: string) => number | undefined
  readonly onToggle: (value: string) => void
  readonly onClear: () => void
  readonly t: Translate
}

function ChipRow({
  facet,
  labelKey,
  values,
  selected,
  label,
  count,
  onToggle,
  onClear,
  t,
}: ChipRowProps) {
  if (values.length === 0) return null
  return (
    <div className="sortiva-opps__facet" role="group" aria-label={t(labelKey)} data-facet={facet}>
      <span className="sortiva-opps__facet-name">{t(labelKey)}</span>
      <button
        type="button"
        className="sortiva-opps__chip"
        aria-pressed={selected.length === 0}
        data-chip="all"
        onClick={onClear}
      >
        {t('opportunities.filter.all')}
      </button>
      {values.map((value) => {
        const n = count?.(value)
        return (
          <button
            key={value}
            type="button"
            className="sortiva-opps__chip"
            aria-pressed={selected.includes(value)}
            data-chip={value}
            onClick={() => onToggle(value)}
          >
            {label(value)}
            {/* A bare count of what is in this facet. Never a denominator:
                the cap is a ceiling, not a target. */}
            {n === undefined ? null : <span className="sortiva-opps__chip-count">{n}</span>}
          </button>
        )
      })}
    </div>
  )
}

export function OpportunityList({
  data,
  t = defaultTranslate,
  initialFilters = DEFAULT_FILTERS,
  initialSort = 'impact',
  initialGrouped = false,
  context,
  onPrimary,
  onDismiss,
  onDetails,
  busyIds = [],
}: OpportunityListProps) {
  const [filters, setFilters] = useState<OpportunityFilters>(initialFilters)
  const [sort, setSort] = useState<SortKey>(initialSort)
  const [grouped, setGrouped] = useState(initialGrouped)

  const signals = signalTypesIn(data.opportunities)
  const visible = sortOpportunities(
    data.opportunities.filter((row) => matchesFilters(row, filters)),
    sort,
  )
  const scan = scanLine(data.lastScanAt, data.nextScanAt, t)

  function card(row: OpportunityRow) {
    return (
      <OpportunityCard
        key={row.id}
        opportunity={row}
        t={t}
        context={context}
        onPrimary={onPrimary}
        onDismiss={onDismiss}
        onDetails={onDetails}
        busy={busyIds.includes(row.id)}
      />
    )
  }

  return (
    <section
      className="sortiva-opps"
      aria-label={t('opportunities.listLabel')}
      data-opportunities-list="true"
      data-opportunities-count={visible.length}
      data-opportunities-grouped={grouped ? 'true' : 'false'}
      data-opportunities-sort={sort}
    >
      {scan ? <p className="sortiva-opps__scan">{scan}</p> : null}

      {data.limitedIntelligence ? (
        <details className="sortiva-opps__limited" data-limited-signals="true">
          <summary>{t('badge.limitedIntelligence.unavailableHeading')}</summary>
          <ul>
            {GSC_DEPENDENT_SIGNALS.map((signal) => (
              <li key={signal} data-unavailable-signal={signal}>
                {signalLabel(signal, t)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="sortiva-opps__controls" aria-label={t('opportunities.filtersLabel')} role="group">
        <ChipRow
          facet="action"
          labelKey="opportunities.filter.action"
          values={ACTION_ORDER}
          selected={filters.action}
          label={(value) => actionLabel(value as (typeof ACTION_ORDER)[number], t)}
          count={(value) => data.counts.byAction[value as (typeof ACTION_ORDER)[number]]}
          onToggle={(value) =>
            setFilters(toggleFilter(filters, 'action', value as (typeof ACTION_ORDER)[number]))
          }
          onClear={() => setFilters({ ...filters, action: [] })}
          t={t}
        />
        <ChipRow
          facet="impact"
          labelKey="opportunities.filter.impact"
          values={IMPACT_ORDER}
          selected={filters.impact}
          label={(value) => impactLabel(value as (typeof IMPACT_ORDER)[number], t)}
          onToggle={(value) =>
            setFilters(toggleFilter(filters, 'impact', value as (typeof IMPACT_ORDER)[number]))
          }
          onClear={() => setFilters({ ...filters, impact: [] })}
          t={t}
        />
        <ChipRow
          facet="status"
          labelKey="opportunities.filter.status"
          values={STATUS_ORDER}
          selected={filters.status}
          label={(value) => statusLabel(value as (typeof STATUS_ORDER)[number], t)}
          onToggle={(value) =>
            setFilters(toggleFilter(filters, 'status', value as (typeof STATUS_ORDER)[number]))
          }
          onClear={() => setFilters({ ...filters, status: [] })}
          t={t}
        />
        <ChipRow
          facet="entity"
          labelKey="opportunities.filter.entity"
          values={ENTITY_ORDER}
          selected={filters.entity}
          label={(value) => entityLabel(value as (typeof ENTITY_ORDER)[number], t)}
          onToggle={(value) =>
            setFilters(toggleFilter(filters, 'entity', value as (typeof ENTITY_ORDER)[number]))
          }
          onClear={() => setFilters({ ...filters, entity: [] })}
          t={t}
        />
        <ChipRow
          facet="signal"
          labelKey="opportunities.filter.signal"
          values={signals}
          selected={filters.signal}
          label={(value) => signalLabel(value, t)}
          onToggle={(value) => setFilters(toggleFilter(filters, 'signal', value))}
          onClear={() => setFilters({ ...filters, signal: [] })}
          t={t}
        />

        <div className="sortiva-opps__tools">
          <label className="sortiva-opps__sort" htmlFor="sortiva-opps-sort">
            {t('opportunities.sortLabel')}
          </label>
          <select
            id="sortiva-opps-sort"
            value={sort}
            onChange={(event) => setSort(event.target.value as SortKey)}
          >
            {SORTS.map((key) => (
              <option key={key} value={key}>
                {t(`opportunities.sort.${key}` as StringKey)}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="sortiva-opps__group-toggle"
            aria-pressed={grouped}
            data-group-toggle="action"
            onClick={() => setGrouped(!grouped)}
          >
            {t('opportunities.groupByAction')}
          </button>
        </div>
      </div>

      {visible.length === 0 ? (
        data.opportunities.length === 0 ? (
          <div className="sortiva-opps__empty" data-opportunities-empty="none">
            <p className="sortiva-opps__empty-headline">{t('opportunities.empty')}</p>
            <p className="sortiva-opps__empty-note">{t('opportunities.emptyNote')}</p>
          </div>
        ) : (
          <div className="sortiva-opps__empty" data-opportunities-empty="filtered">
            <p className="sortiva-opps__empty-headline">{t('opportunities.emptyFiltered')}</p>
            <button
              type="button"
              className="sortiva-opps__clear"
              onClick={() => setFilters(DEFAULT_FILTERS)}
            >
              {t('opportunities.clearFilters')}
            </button>
          </div>
        )
      ) : grouped ? (
        groupByAction(visible).map((group) => (
          <section
            key={group.action}
            className="sortiva-opps__group"
            data-opportunity-group={group.action}
            aria-label={t('opportunities.groupLabel', { action: actionLabel(group.action, t) })}
          >
            <h2 className="sortiva-opps__group-heading">{actionLabel(group.action, t)}</h2>
            {group.rows.map(card)}
          </section>
        ))
      ) : (
        <div className="sortiva-opps__cards">{visible.map(card)}</div>
      )}
    </section>
  )
}

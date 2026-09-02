'use client'

import { useState, type KeyboardEvent } from 'react'
import { useUiAnalytics } from '../analytics'
import { t as defaultTranslate, type Translate } from '../strings'
import {
  canAddCompetitor,
  groupingLabelKey,
  moveItem,
  richnessKeys,
  sourceLabelKey,
  type CompetitorSuggestion,
  type DraftCompetitor,
  type DraftFamily,
  type DraftKeyword,
  type DraftProduct,
  type DraftRichness,
} from './confirmation'

/**
 * The six sections of the confirmation review that are lists rather than
 * fields. Each owns its own edits and reports them upward, so the screen
 * around them stays a layout rather than a state machine.
 */

export interface SectionProps {
  readonly t?: Translate
}

// ── Top products ─────────────────────────────────────────────────────────────

export interface TopProductsSectionProps extends SectionProps {
  readonly products: readonly DraftProduct[]
  readonly onChange: (products: readonly DraftProduct[]) => void
}

/**
 * The best sellers, in the order they will be treated as important.
 *
 * The order matters downstream — it is what the persona and the seed keywords
 * are drawn from — so the merchant can correct it. Rows are draggable, and the
 * handle also answers the arrow keys, because an ordering control that only
 * works with a mouse is one a keyboard or a phone cannot use at all.
 */
export function TopProductsSection({
  products,
  onChange,
  t = defaultTranslate,
}: TopProductsSectionProps) {
  const [dragging, setDragging] = useState<number | null>(null)

  function move(from: number, to: number) {
    if (to < 0 || to >= products.length) return
    onChange(moveItem(products, from, to))
  }

  function onHandleKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(index, index - 1)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(index, index + 1)
    }
  }

  return (
    <section className="sortiva-confirm__section" data-confirm-section="top_products">
      <h2 className="sortiva-confirm__section-heading">{t('confirm.products.heading')}</h2>
      <p className="sortiva-confirm__section-note">{t('confirm.products.note')}</p>
      <ol className="sortiva-confirm__products">
        {products.map((product, index) => (
          <li
            key={product.id}
            draggable
            onDragStart={() => setDragging(index)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (dragging !== null) move(dragging, index)
              setDragging(null)
            }}
          >
            <button
              type="button"
              className="sortiva-confirm__handle"
              aria-label={t('confirm.products.reorder')}
              onKeyDown={(event) => onHandleKey(event, index)}
            >
              ⠿
            </button>
            {product.imageUrl ? (
              <img src={product.imageUrl} alt={product.title} width={40} height={40} />
            ) : null}
            <span className="sortiva-confirm__product-title">{product.title}</span>
            <span className="sortiva-confirm__badge">{t(sourceLabelKey(product.source))}</span>
            {product.revenueBand ? (
              <span className="sortiva-confirm__badge" data-revenue-band={product.revenueBand} />
            ) : null}
            {product.pinned ? (
              <span className="sortiva-confirm__badge">{t('confirm.products.pinned')}</span>
            ) : null}
            <button
              type="button"
              className="sortiva-confirm__remove"
              aria-label={t('confirm.remove')}
              onClick={() => onChange(products.filter((other) => other.id !== product.id))}
            >
              ×
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
}

// ── Keywords ─────────────────────────────────────────────────────────────────

export interface KeywordsSectionProps extends SectionProps {
  readonly keywords: readonly DraftKeyword[]
  readonly onChange: (keywords: readonly DraftKeyword[]) => void
  readonly addEndpoint?: string
  readonly removeEndpoint?: (id: string) => string
}

/**
 * The search terms this store will be planned around.
 *
 * A hand-added term has no volume or difficulty until a paid lookup returns,
 * which takes long enough to be worth not waiting for — so a pending chip
 * shows that it is still fetching rather than showing a zero, and confirming
 * while one is in flight is allowed. A zero would be a claim; "fetching" is
 * the truth.
 */
export function KeywordsSection({
  keywords,
  onChange,
  addEndpoint = '/api/profile/keywords',
  removeEndpoint = (id) => `/api/profile/keywords/${id}`,
  t = defaultTranslate,
}: KeywordsSectionProps) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)

  async function add() {
    const term = typed.trim()
    if (term.length === 0 || busy) return
    setBusy(true)
    try {
      const response = await fetch(addEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ term }),
      })
      if (!response.ok) return
      onChange([...keywords, (await response.json()) as DraftKeyword])
      setTyped('')
    } catch {
      // Nothing was added; the term stays in the field to try again.
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    onChange(keywords.filter((keyword) => keyword.id !== id))
    try {
      await fetch(removeEndpoint(id), { method: 'DELETE' })
    } catch {
      // The row is already gone from the screen; the next load is the truth.
    }
  }

  return (
    <section className="sortiva-confirm__section" data-confirm-section="keywords">
      <h2 className="sortiva-confirm__section-heading">{t('confirm.keywords.heading')}</h2>
      <ul className="sortiva-confirm__chips">
        {keywords.map((keyword) => (
          <li key={keyword.id} data-enrichment={keyword.enrichmentState}>
            <span className="sortiva-confirm__chip-term">{keyword.term}</span>
            {keyword.enrichmentState === 'pending' ? (
              <span className="sortiva-confirm__chip-meta">{t('confirm.keywords.pending')}</span>
            ) : keyword.enrichmentState === 'failed' ? (
              <span className="sortiva-confirm__chip-meta">{t('confirm.keywords.failed')}</span>
            ) : (
              <span className="sortiva-confirm__chip-meta">
                {keyword.monthlySearchVolume === null
                  ? null
                  : t('confirm.keywords.volume', { value: keyword.monthlySearchVolume })}
                {keyword.difficulty === null
                  ? null
                  : t('confirm.keywords.difficulty', { value: keyword.difficulty })}
              </span>
            )}
            <button
              type="button"
              className="sortiva-confirm__remove"
              aria-label={t('confirm.remove')}
              onClick={() => remove(keyword.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      <div className="sortiva-confirm__add">
        <label htmlFor="sortiva-add-keyword">{t('confirm.keywords.addLabel')}</label>
        <input
          id="sortiva-add-keyword"
          value={typed}
          placeholder={t('confirm.keywords.addPlaceholder')}
          onChange={(event) => setTyped(event.target.value)}
        />
        <button type="button" onClick={add} disabled={busy}>
          {t('confirm.keywords.add')}
        </button>
      </div>
      <p className="sortiva-confirm__section-note">{t('confirm.keywords.note')}</p>
    </section>
  )
}

// ── Competitors ──────────────────────────────────────────────────────────────

export interface CompetitorsSectionProps extends SectionProps {
  readonly competitors: readonly DraftCompetitor[]
  readonly suggestions: readonly CompetitorSuggestion[]
  readonly onChange: (competitors: readonly DraftCompetitor[]) => void
  readonly addEndpoint?: string
  readonly removeEndpoint?: (id: string) => string
}

type CompetitorError = 'own_domain' | 'blocked' | 'limit' | 'failed'

/**
 * The five businesses this store is measured against.
 *
 * Five is a hard cap, enforced in the API and in the database — this screen
 * only switches the controls off before a refusal happens. Suggestions come
 * from domains seen ranking for the store's own searches; they are offered and
 * never added on our own, because a domain that ranks alongside you is not
 * necessarily a business you compete with.
 */
export function CompetitorsSection({
  competitors,
  suggestions,
  onChange,
  addEndpoint = '/api/profile/competitors',
  removeEndpoint = (id) => `/api/profile/competitors/${id}`,
  t = defaultTranslate,
}: CompetitorsSectionProps) {
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<CompetitorError | null>(null)
  const [pendingBlocked, setPendingBlocked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const atCap = !canAddCompetitor(competitors)

  async function add(domain: string, overrideBlocklist = false) {
    if (domain.length === 0 || busy) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(addEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(overrideBlocklist ? { domain, overrideBlocklist } : { domain }),
      })

      if (response.ok) {
        onChange([...competitors, (await response.json()) as DraftCompetitor])
        setTyped('')
        setPendingBlocked(null)
        return
      }

      if (response.status === 409) {
        const body = (await response.json()) as { error?: { code?: string } }
        setError(body.error?.code === 'competitor_is_own_domain' ? 'own_domain' : 'limit')
        return
      }

      // Anything else the route refuses on a well-formed domain is the
      // marketplace blocklist, which the merchant is allowed to override
      // deliberately — so the refusal is offered back as a choice.
      setError('blocked')
      setPendingBlocked(domain)
    } catch {
      setError('failed')
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    onChange(competitors.filter((competitor) => competitor.id !== id))
    setError(null)
    try {
      await fetch(removeEndpoint(id), { method: 'DELETE' })
    } catch {
      // Already gone from the screen; the next load is the truth.
    }
  }

  return (
    <section className="sortiva-confirm__section" data-confirm-section="competitors">
      <h2 className="sortiva-confirm__section-heading">{t('confirm.competitors.heading')}</h2>

      <ul className="sortiva-confirm__competitors">
        {competitors.map((competitor) => (
          <li key={competitor.id}>
            <span>{competitor.domain}</span>
            <span className="sortiva-confirm__badge">{t(sourceLabelKey(competitor.source))}</span>
            <button
              type="button"
              className="sortiva-confirm__remove"
              aria-label={t('confirm.remove')}
              onClick={() => remove(competitor.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      {suggestions.length > 0 ? (
        <div className="sortiva-confirm__suggestions">
          <h3 className="sortiva-confirm__section-note">
            {t('confirm.competitors.suggestionsHeading')}
          </h3>
          <ul>
            {suggestions
              .filter((suggestion) => !competitors.some((c) => c.domain === suggestion.domain))
              .map((suggestion) => (
                <li key={suggestion.domain}>
                  <span>{suggestion.domain}</span>
                  <span className="sortiva-confirm__badge">
                    {t('confirm.competitors.suggestionAppears', { count: suggestion.appearsInQueries })}
                  </span>
                  <button
                    type="button"
                    disabled={atCap || busy}
                    title={atCap ? t('confirm.competitors.capTooltip') : undefined}
                    onClick={() => add(suggestion.domain)}
                  >
                    {t('confirm.competitors.addSuggestion')}
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ) : null}

      <div className="sortiva-confirm__add" data-competitors-at-cap={atCap ? 'true' : 'false'}>
        <label htmlFor="sortiva-add-competitor">{t('confirm.competitors.addLabel')}</label>
        <input
          id="sortiva-add-competitor"
          value={typed}
          placeholder={t('confirm.competitors.addPlaceholder')}
          disabled={atCap}
          title={atCap ? t('confirm.competitors.capTooltip') : undefined}
          onChange={(event) => {
            setTyped(event.target.value)
            setError(null)
          }}
        />
        <button
          type="button"
          disabled={atCap || busy}
          title={atCap ? t('confirm.competitors.capTooltip') : undefined}
          onClick={() => add(typed.trim())}
        >
          {t('confirm.competitors.add')}
        </button>
      </div>

      <p className="sortiva-confirm__section-note">{t('confirm.competitors.capTooltip')}</p>

      {error ? (
        <p className="sortiva-confirm__error" role="alert" data-competitor-error={error}>
          {error === 'own_domain'
            ? t('confirm.competitors.ownDomain')
            : error === 'limit'
              ? t('confirm.competitors.limitReached')
              : error === 'blocked'
                ? t('confirm.competitors.blocked')
                : t('confirm.competitors.failed')}
          {error === 'blocked' && pendingBlocked ? (
            <button type="button" onClick={() => add(pendingBlocked, true)} disabled={busy}>
              {t('confirm.competitors.addAnyway')}
            </button>
          ) : null}
        </p>
      ) : null}
    </section>
  )
}

// ── Product families ─────────────────────────────────────────────────────────

export interface FamiliesSectionProps extends SectionProps {
  readonly families: readonly DraftFamily[]
  readonly reportEndpoint?: string
}

/**
 * How the catalogue was grouped, shown and not editable.
 *
 * Grouping decides what a single article can cover — forty shoes differing
 * only by colour support one guide, not forty — so the merchant should see it.
 * A split-and-merge editor is a screen of its own and is not in this version,
 * so the escape hatch is a report: it reaches support, and it tells us the
 * grouping is wrong without pretending the merchant can fix it.
 */
export function FamiliesSection({
  families,
  reportEndpoint = '/api/products/families/report',
  t = defaultTranslate,
}: FamiliesSectionProps) {
  const analytics = useUiAnalytics()
  const [reporting, setReporting] = useState<DraftFamily | null>(null)
  const [reason, setReason] = useState('')
  const [thanks, setThanks] = useState(false)

  async function send(family: DraftFamily) {
    const text = reason.trim()
    if (text.length === 0) return
    try {
      await fetch(reportEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ familyId: family.id, reason: text }),
      })
    } catch {
      // The report is feedback rather than a change; a lost one is not worth
      // an error message that makes the merchant think something broke.
    }
    // What they typed is about their own catalogue and goes to support only.
    // What reaches analytics is which family, how big it was, and which signal
    // grouped it — enough to see whether we merge too eagerly.
    analytics.capture('family_grouping_reported', {
      family_id: family.id,
      member_count: family.memberCount,
      grouping_source: family.groupingSource,
    })
    setReporting(null)
    setReason('')
    setThanks(true)
  }

  return (
    <section className="sortiva-confirm__section" data-confirm-section="families">
      <h2 className="sortiva-confirm__section-heading">{t('confirm.families.heading')}</h2>
      <span className="sortiva-confirm__badge">{t('confirm.families.readOnly')}</span>

      {families.map((family) => (
        <details key={family.id} className="sortiva-confirm__family">
          <summary>
            <span className="sortiva-confirm__family-label">{family.label}</span>
            <span className="sortiva-confirm__badge">
              {t('confirm.families.members', { count: family.memberCount })}
            </span>
            <span className="sortiva-confirm__badge">{t(groupingLabelKey(family.groupingSource))}</span>
            {family.lowConfidence ? (
              <span className="sortiva-confirm__badge">{t('confirm.families.lowConfidence')}</span>
            ) : null}
          </summary>
          <ul className="sortiva-confirm__axes">
            {family.axes.map((axis) => (
              <li key={axis}>{axis}</li>
            ))}
          </ul>
          <button type="button" onClick={() => setReporting(family)}>
            {t('confirm.families.report')}
          </button>
        </details>
      ))}

      {reporting ? (
        <div className="sortiva-confirm__report" role="dialog" aria-label={t('confirm.families.reportHeading')}>
          <h3>{t('confirm.families.reportHeading')}</h3>
          <label htmlFor="sortiva-family-reason">{t('confirm.families.reportLabel')}</label>
          <textarea
            id="sortiva-family-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <button type="button" onClick={() => send(reporting)}>
            {t('confirm.families.reportSubmit')}
          </button>
          <button type="button" onClick={() => setReporting(null)}>
            {t('confirm.families.reportCancel')}
          </button>
        </div>
      ) : null}

      {thanks ? <p role="status">{t('confirm.families.reportThanks')}</p> : null}
      <p className="sortiva-confirm__section-note">{t('confirm.families.note')}</p>
    </section>
  )
}

// ── Data richness ────────────────────────────────────────────────────────────

export interface RichnessSectionProps extends SectionProps {
  readonly richness: DraftRichness
}

export function RichnessSection({ richness, t = defaultTranslate }: RichnessSectionProps) {
  const keys = richnessKeys(richness.band)

  return (
    <section className="sortiva-confirm__section" data-confirm-section="richness" data-richness-band={richness.band}>
      <h2 className="sortiva-confirm__section-heading">{t('confirm.richness.heading')}</h2>
      <p className="sortiva-confirm__section-note">{t('confirm.richness.note')}</p>
      <p className="sortiva-confirm__richness-band">{t(keys.name)}</p>
      <p className="sortiva-confirm__section-body">{t(keys.explain)}</p>
      {richness.productsMissingDetails > 0 ? (
        <p className="sortiva-confirm__section-body">
          {t('confirm.richness.missing', { count: richness.productsMissingDetails })}
        </p>
      ) : null}
    </section>
  )
}

// ── Search Console status ────────────────────────────────────────────────────

export interface SearchConsoleStatusProps extends SectionProps {
  readonly searchConsole: { readonly connected: boolean; readonly property: string | null }
  readonly connectHref?: string
}

export function SearchConsoleStatusSection({
  searchConsole,
  connectHref = '/settings/connections',
  t = defaultTranslate,
}: SearchConsoleStatusProps) {
  return (
    <section className="sortiva-confirm__section" data-confirm-section="search_console">
      <h2 className="sortiva-confirm__section-heading">{t('confirm.gsc.heading')}</h2>
      {searchConsole.connected ? (
        <p className="sortiva-confirm__section-body">
          {t('confirm.gsc.connected')}
          {searchConsole.property ? <code>{searchConsole.property}</code> : null}
        </p>
      ) : (
        <p className="sortiva-confirm__section-body">
          {t('confirm.gsc.skipped')} <a href={connectHref}>{t('confirm.gsc.connectNow')}</a>
        </p>
      )}
      <p className="sortiva-confirm__section-note">{t('confirm.gsc.informational')}</p>
    </section>
  )
}

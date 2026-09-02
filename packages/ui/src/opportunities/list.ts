import { t as defaultTranslate, type StringKey, type Translate } from '../strings'
import type {
  ConfidenceBand,
  EntityKind,
  EvidenceFact,
  ImpactBand,
  OpportunityAction,
  OpportunityRow,
  OpportunityStatus,
} from './types'

/**
 * Everything the Opportunities list decides before anything is drawn: which
 * cards a set of filter chips leaves standing, what order they come in, how
 * they group, and what the one button on each card should say.
 *
 * Kept apart from the components so the rules can be read and tested as rules.
 */

/**
 * Group-by renders these as sections in this order, always. It is the order of
 * escalating commitment — write something new, improve what you have, revive
 * what is fading, clear an obstacle, wait for the merchant — and a list that
 * reordered itself by which group happened to be biggest would stop being
 * learnable.
 */
export const ACTION_ORDER: readonly OpportunityAction[] = [
  'CREATE',
  'OPTIMIZE',
  'REFRESH',
  'FIX',
  'HOLD',
]

export const IMPACT_ORDER: readonly ImpactBand[] = ['high', 'medium', 'low']

export const STATUS_ORDER: readonly OpportunityStatus[] = [
  'new',
  'accepted',
  'scheduled',
  'executing',
  'completed',
  'dismissed',
  'blocked',
  'expired',
]

export const ENTITY_ORDER: readonly EntityKind[] = [
  'query_cluster',
  'page',
  'product',
  'family',
  'article',
]

/**
 * The signals that need Google's own query data, and therefore go unevaluated
 * on a store that has not connected Search Console.
 *
 * Fixed here rather than read from the API because it is a property of how
 * detection works, not of the account: without query data these cannot run for
 * anybody. Naming them under the header is what turns "Limited" from a vague
 * warning into a specific claim the merchant can weigh.
 */
export const GSC_DEPENDENT_SIGNALS: readonly string[] = [
  'striking_distance',
  'low_ctr_at_strong_rank',
  'content_decay',
  'cannibalization',
  'indexing_issue',
  'wrong_canonical',
  'freshness_opportunity',
]

/**
 * What the screen shows before anyone touches a filter: the things still to be
 * decided. Completed and expired rows are history and dismissed ones were
 * refused, so none of the three belongs in a list whose job is "what now".
 */
export const DEFAULT_STATUSES: readonly OpportunityStatus[] = [
  'new',
  'accepted',
  'blocked',
]

export type SortKey = 'impact' | 'confidence' | 'newest'

export interface OpportunityFilters {
  readonly action: readonly OpportunityAction[]
  readonly impact: readonly ImpactBand[]
  readonly status: readonly OpportunityStatus[]
  readonly entity: readonly EntityKind[]
  readonly signal: readonly string[]
}

export const DEFAULT_FILTERS: OpportunityFilters = {
  action: [],
  impact: [],
  status: DEFAULT_STATUSES,
  entity: [],
  signal: [],
}

/** An empty facet means "no opinion", not "nothing" — a chip nobody clicked filters nothing out. */
function passes<T>(selected: readonly T[], value: T): boolean {
  return selected.length === 0 || selected.includes(value)
}

export function matchesFilters(row: OpportunityRow, filters: OpportunityFilters): boolean {
  return (
    passes(filters.action, row.recommendedAction) &&
    passes(filters.impact, row.impact) &&
    passes(filters.status, row.status) &&
    passes(filters.entity, row.entityRef.kind) &&
    passes(filters.signal, row.signalType)
  )
}

/** Adding or removing one value from a facet, which is what clicking a chip does. */
export function toggleFilter<K extends keyof OpportunityFilters>(
  filters: OpportunityFilters,
  facet: K,
  value: OpportunityFilters[K][number],
): OpportunityFilters {
  const current = filters[facet] as readonly typeof value[]
  const next = current.includes(value)
    ? current.filter((entry) => entry !== value)
    : [...current, value]
  return { ...filters, [facet]: next }
}

export function isDefaultFilters(filters: OpportunityFilters): boolean {
  return (
    filters.action.length === 0 &&
    filters.impact.length === 0 &&
    filters.entity.length === 0 &&
    filters.signal.length === 0 &&
    filters.status.length === DEFAULT_STATUSES.length &&
    DEFAULT_STATUSES.every((status) => filters.status.includes(status))
  )
}

const BAND_RANK = { high: 0, medium: 1, low: 2 } as const

function impactRank(band: ImpactBand): number {
  return BAND_RANK[band]
}

function confidenceRank(band: ConfidenceBand): number {
  return BAND_RANK[band]
}

/**
 * Impact first, then confidence, exactly as the scoring section orders them —
 * and the id last, so two rows the engine scored identically still come out in
 * the same order on every render rather than shuffling between page loads.
 */
export function sortOpportunities(
  rows: readonly OpportunityRow[],
  sort: SortKey,
): readonly OpportunityRow[] {
  const sorted = [...rows]
  sorted.sort((a, b) => {
    if (sort === 'newest') {
      const byDate = Date.parse(b.detectedAt) - Date.parse(a.detectedAt)
      if (byDate !== 0) return byDate
    } else if (sort === 'confidence') {
      const byBand = confidenceRank(a.confidence) - confidenceRank(b.confidence)
      if (byBand !== 0) return byBand
      // Bands are wide — anything at seventy or above is "high" — so two cards
      // in the same band are ordered by the score behind it, or sorting by
      // confidence would leave most of the list untouched.
      const byScore = b.confidenceScore - a.confidenceScore
      if (byScore !== 0) return byScore
    } else {
      const byImpact = impactRank(a.impact) - impactRank(b.impact)
      if (byImpact !== 0) return byImpact
      const byScore = b.impactScore - a.impactScore
      if (byScore !== 0) return byScore
      const byConfidence = confidenceRank(a.confidence) - confidenceRank(b.confidence)
      if (byConfidence !== 0) return byConfidence
    }
    return a.id.localeCompare(b.id)
  })
  return sorted
}

export interface ActionGroup {
  readonly action: OpportunityAction
  readonly rows: readonly OpportunityRow[]
}

/** The five sections in their fixed order. An action with nothing in it is dropped, not shown empty. */
export function groupByAction(rows: readonly OpportunityRow[]): readonly ActionGroup[] {
  return ACTION_ORDER.map((action) => ({
    action,
    rows: rows.filter((row) => row.recommendedAction === action),
  })).filter((group) => group.rows.length > 0)
}

/** Which signal types are actually present, so the filter offers only real ones. */
export function signalTypesIn(rows: readonly OpportunityRow[]): readonly string[] {
  return [...new Set(rows.map((row) => row.signalType))].sort()
}

// ── Words for the things the API sends as codes ───────────────────────────────

/**
 * A code with no label yet is spelled out rather than hidden. The engine's
 * signal catalogue is longer than what is built, so a type arriving before its
 * wording does is expected; showing `low_ctr_at_strong_rank` reads badly but
 * tells the truth, and a card silently missing its signal tag would not.
 */
function humanise(code: string): string {
  const spaced = code.replace(/[._-]+/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function lookup(t: Translate, key: string, fallback: string): string {
  try {
    return t(key as StringKey)
  } catch {
    return fallback
  }
}

export function signalLabel(signalType: string, t: Translate = defaultTranslate): string {
  return lookup(t, `opportunities.signal.${signalType}`, humanise(signalType))
}

export function sourceLabel(source: string, t: Translate = defaultTranslate): string {
  return lookup(t, `opportunities.source.${source}`, humanise(source))
}

export function preconditionLabel(code: string, t: Translate = defaultTranslate): string {
  return lookup(t, `opportunities.precondition.${code}`, humanise(code).toLowerCase())
}

export function actionLabel(action: OpportunityAction, t: Translate = defaultTranslate): string {
  return t(`opportunities.action.${action}` as StringKey)
}

export function impactLabel(impact: ImpactBand, t: Translate = defaultTranslate): string {
  return t(`opportunities.impact.${impact}` as StringKey)
}

export function confidenceLabel(band: ConfidenceBand, t: Translate = defaultTranslate): string {
  return t(`opportunities.confidence.${band}` as StringKey)
}

export function entityLabel(kind: EntityKind, t: Translate = defaultTranslate): string {
  return t(`opportunities.entity.${kind}` as StringKey)
}

export function statusLabel(status: OpportunityStatus, t: Translate = defaultTranslate): string {
  return t(`opportunities.status.${status}` as StringKey)
}

/** A field of an OPTIMIZE recommendation. The engine's set is open, so unknown names are spelled out. */
export function recommendationFieldLabel(field: string, t: Translate = defaultTranslate): string {
  return lookup(t, `opportunities.rec.field.${field}`, humanise(field))
}

/**
 * When the store was last looked at, and when it will be looked at again.
 *
 * The next date comes from the response rather than the word "Monday", which
 * is what the spec and the design both write: a store whose scan day is not
 * Monday would otherwise be told something untrue every week. The empty state
 * keeps the sentence as written, because that one is quoted.
 */
export function scanLine(
  lastScanAt: string | null,
  nextScanAt: string | null,
  t: Translate = defaultTranslate,
): string | null {
  if (lastScanAt && nextScanAt) {
    return t('opportunities.scanLine', { date: formatDate(lastScanAt), next: formatDate(nextScanAt) })
  }
  if (nextScanAt) return t('opportunities.scanLineFirst', { next: formatDate(nextScanAt) })
  if (lastScanAt) return t('opportunities.scanLineLastOnly', { date: formatDate(lastScanAt) })
  return null
}

/** `28d` is the window every Search Console signal uses; anything else is passed through as written. */
export function windowLabel(window: string | undefined, t: Translate = defaultTranslate): string | null {
  if (!window) return t('opportunities.window.current')
  const days = /^(\d+)d$/.exec(window)
  if (days) return t('opportunities.window.days', { days: Number(days[1]) })
  return window
}

/** Numbers a merchant reads: thousands separated, decimals kept where the engine sent them. */
export function formatValue(value: string | number): string {
  if (typeof value === 'string') return value
  return Number.isInteger(value) ? value.toLocaleString('en-GB') : String(value)
}

export function factLabel(fact: EvidenceFact, t: Translate = defaultTranslate): string {
  const value = formatValue(fact.value)
  try {
    return t(`opportunities.evidence.${fact.key}` as StringKey, { value })
  } catch {
    return `${value} ${humanise(fact.key).toLowerCase()}`
  }
}

/**
 * The one line of numbers on a card: two or three facts, then where they came
 * from and over what period.
 *
 * Three at most because a card is scanned, not studied, and because the source
 * and window at the end are what make the numbers mean anything — a fourth fact
 * pushes them off the line. The source shown is the one behind the first fact,
 * which is the fact the engine ranked highest.
 */
export function evidenceLine(
  facts: readonly EvidenceFact[],
  t: Translate = defaultTranslate,
): string | null {
  if (facts.length === 0) return null
  const shown = facts.slice(0, 3)
  const parts = shown.map((fact) => factLabel(fact, t))
  const lead = shown[0]!
  const provenance = t('opportunities.sourceWindow', {
    source: sourceLabel(lead.source, t),
    window: windowLabel(lead.window, t) ?? '',
  })
  return [...parts, provenance].join(' · ')
}

// ── The one button per card ──────────────────────────────────────────────────

export type PrimaryActionKind =
  | 'schedule'
  | 'schedule_refresh'
  | 'on_calendar'
  | 'generate'
  | 'view_recommendation'
  | 'see_what_to_add'

export interface PrimaryAction {
  readonly kind: PrimaryActionKind
  readonly label: string
  /** A link rather than a button: going somewhere else, not doing something here. */
  readonly href?: string
  /** In flight, or refused by the daily cap — the button is on screen but cannot be pressed. */
  readonly disabled: boolean
}

export interface PrimaryActionContext {
  /** Set once a generation has been asked for and the drawer has not yet shown a result. */
  readonly generating?: boolean
  /** The daily recommendation cap has already refused one today. */
  readonly capReached?: boolean
  /**
   * How many recommendations a day the account is allowed, when something has
   * told us. The cap is configuration on the server and no response carries it,
   * so the note says only that the limit is reached unless a caller supplies it
   * — a number typed into the copy would be a promise the config could break.
   */
  readonly optimizeDailyCap?: number
  readonly productsHref?: string
}

/** The line beside a refused "generate" button. */
export function optimizeCapNote(
  t: Translate = defaultTranslate,
  cap?: number,
): string {
  return cap === undefined
    ? t('opportunities.optimizeCap')
    : t('opportunities.optimizeCapKnown', { cap })
}

/**
 * What the card offers, by action type.
 *
 * CREATE and REFRESH are already accepted and will be scheduled by the
 * replenishment run on their own; the button exists to pull one forward, and
 * once a date exists it stops being a button and becomes a link to the day.
 */
export function primaryAction(
  row: OpportunityRow,
  t: Translate = defaultTranslate,
  context: PrimaryActionContext = {},
): PrimaryAction | null {
  const scheduled = row.scheduledFor
  switch (row.recommendedAction) {
    case 'CREATE':
      return scheduled
        ? {
            kind: 'on_calendar',
            label: t('opportunities.primary.onCalendar', { date: formatDate(scheduled) }),
            href: '/content',
            disabled: false,
          }
        : { kind: 'schedule', label: t('opportunities.primary.schedule'), disabled: false }
    case 'REFRESH':
      return scheduled
        ? {
            kind: 'on_calendar',
            label: t('opportunities.primary.onCalendar', { date: formatDate(scheduled) }),
            href: '/content',
            disabled: false,
          }
        : {
            kind: 'schedule_refresh',
            label: t('opportunities.primary.scheduleRefresh'),
            disabled: false,
          }
    case 'OPTIMIZE':
      return {
        kind: 'generate',
        label: context.generating
          ? t('opportunities.generating')
          : t('opportunities.primary.generate'),
        disabled: Boolean(context.generating || context.capReached),
      }
    case 'FIX':
      return {
        kind: 'view_recommendation',
        label: t('opportunities.primary.viewRecommendation'),
        disabled: false,
      }
    case 'HOLD':
      return {
        kind: 'see_what_to_add',
        label: t('opportunities.primary.seeWhatToAdd'),
        href: context.productsHref ?? '/products',
        disabled: false,
      }
  }
}

/**
 * The chip on a card that is no longer simply waiting. `new` and `accepted`
 * get none: they are the ordinary state and a chip saying so would be noise on
 * every card in the list.
 */
export function statusChip(row: OpportunityRow, t: Translate = defaultTranslate): string | null {
  switch (row.status) {
    case 'scheduled':
      return row.scheduledFor
        ? t('opportunities.chip.scheduled', { date: formatDate(row.scheduledFor) })
        : t('opportunities.status.scheduled')
    case 'executing':
      return t('opportunities.status.executing')
    // The list response carries no completion date, so the chip says only that
    // it is done. The date and the before/after numbers are in the drawer,
    // where the detail response does carry them.
    case 'completed':
      return t('opportunities.status.completed')
    case 'expired':
      return t('opportunities.chip.expired')
    case 'dismissed':
      return t('opportunities.status.dismissed')
    case 'blocked':
      return t('opportunities.status.blocked')
    default:
      return null
  }
}

/** `2026-02-14` and `2026-02-14T…` both read as `14 Feb 2026`. */
export function formatDate(iso: string): string {
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00.000Z` : iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

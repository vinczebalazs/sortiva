import type { StringKey } from '../strings'

/**
 * The confirmation screen's arithmetic, kept out of the component so it can be
 * tested by describing a draft rather than by driving a browser through the
 * longest screen in the product.
 *
 * Nothing here talks to the API. It answers three kinds of question: is this
 * draft complete enough to confirm, may another competitor be added, and what
 * does this row's badge say.
 */

export interface DraftKeyword {
  readonly id: string
  readonly term: string
  readonly monthlySearchVolume: number | null
  readonly difficulty: number | null
  readonly source: 'auto' | 'manual'
  readonly enrichmentState: 'pending' | 'enriched' | 'failed'
}

export interface DraftCompetitor {
  readonly id: string
  readonly domain: string
  readonly source: 'auto' | 'manual'
}

export interface CompetitorSuggestion {
  readonly domain: string
  readonly appearsInQueries: number
}

export interface DraftProduct {
  readonly id: string
  readonly title: string
  readonly imageUrl: string | null
  readonly source: 'orders_api' | 'heuristic' | 'manual'
  readonly pinned: boolean
  readonly revenueBand: string | null
}

export interface DraftFamily {
  readonly id: string
  readonly label: string
  readonly memberCount: number
  readonly axes: readonly string[]
  readonly groupingSource: 'taxonomy' | 'fact_clustering' | 'embedding'
  readonly lowConfidence: boolean
}

export interface DraftRichness {
  readonly band: 'rich' | 'okay' | 'sparse'
  readonly productsMissingDetails: number
}

export interface ProfileDraft {
  readonly description: string
  readonly language: string
  readonly country: string
  readonly audience: string
  readonly tone: string
  readonly topProducts: readonly DraftProduct[]
  readonly keywords: readonly DraftKeyword[]
  readonly competitors: readonly DraftCompetitor[]
  readonly competitorSuggestions: readonly CompetitorSuggestion[]
  readonly families: readonly DraftFamily[]
  readonly richness: DraftRichness
  readonly searchConsole: { readonly connected: boolean; readonly property: string | null }
  readonly confirmed: boolean
}

/**
 * At most five business competitors. The API and the database each enforce
 * this on their own — the database with a trigger, so neither the screen nor
 * the route is the only thing standing between us and a sixth. What the number
 * does here is switch a control off before the merchant presses it and gets a
 * refusal; it is a courtesy, never the enforcement.
 *
 * The cap exists because competitor analysis is the most expensive thing the
 * product runs: every extra competitor multiplies the paid search lookups in
 * topic discovery and in measuring results.
 */
export const MAX_COMPETITORS = 5

export function canAddCompetitor(competitors: readonly unknown[]): boolean {
  return competitors.length < MAX_COMPETITORS
}

/**
 * Whether the draft can be confirmed.
 *
 * Only the fields the confirmation request itself requires are checked:
 * something to describe the business, and a language and country, because
 * every search lookup after this point is made in one language in one market
 * and a wrong answer there quietly poisons everything downstream. Audience and
 * tone shape the writing rather than the searching, so an empty one costs
 * quality rather than correctness — and blocking on them would strand a
 * merchant whose store genuinely has no house style.
 *
 * Keyword enrichment still running is deliberately not a reason to wait.
 */
export function isConfirmable(draft: {
  description: string
  language: string
  country: string
}): boolean {
  return (
    draft.description.trim().length > 0 &&
    draft.language.trim().length >= 2 &&
    draft.country.trim().length === 2
  )
}

/** Moves one row of the ranked product list, returning a new list. */
export function moveItem<T>(items: readonly T[], from: number, to: number): readonly T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved as T)
  return next
}

const SOURCE_LABELS = {
  orders_api: 'confirm.source.orders_api',
  heuristic: 'confirm.source.heuristic',
  manual: 'confirm.source.manual',
  auto: 'confirm.source.auto',
} as const

/** What a row's provenance badge says — order data, an estimate, or a hand edit. */
export function sourceLabelKey(source: keyof typeof SOURCE_LABELS): StringKey {
  return SOURCE_LABELS[source]
}

const GROUPING_LABELS = {
  taxonomy: 'confirm.families.source.taxonomy',
  fact_clustering: 'confirm.families.source.fact_clustering',
  embedding: 'confirm.families.source.embedding',
} as const

/** Which signal produced a family, so a wrong grouping is debuggable from the screen. */
export function groupingLabelKey(source: DraftFamily['groupingSource']): StringKey {
  return GROUPING_LABELS[source]
}

const RICHNESS_BANDS = {
  rich: { name: 'confirm.richness.band.rich', explain: 'confirm.richness.explain.rich' },
  okay: { name: 'confirm.richness.band.okay', explain: 'confirm.richness.explain.okay' },
  sparse: { name: 'confirm.richness.band.sparse', explain: 'confirm.richness.explain.sparse' },
} as const

/**
 * How much the store's own pages actually state, in three bands and a sentence.
 *
 * It is informational and never blocks confirming: a sparse catalogue is a
 * fact about the store, not a mistake the merchant has to fix before starting.
 * What it does is set the expectation before the first day is held back for
 * lack of substance, so that day reads as the system working rather than
 * failing.
 */
export function richnessKeys(band: DraftRichness['band']): { name: StringKey; explain: StringKey } {
  return RICHNESS_BANDS[band]
}

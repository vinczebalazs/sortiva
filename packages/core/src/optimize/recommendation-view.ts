import { fieldRationale, type OptimizeRecommendation } from './recommendation'

/**
 * The one place a stored recommendation becomes something a merchant reads.
 *
 * Two screens show this advice — the opportunity drawer and the recommendation
 * card behind `/api/recommendations` — and they are meant to say the same
 * thing about the same page. They were briefly two functions, and two copies
 * of a mapping are two answers waiting to disagree. The drawer's narrower
 * shape is now cut from the full one below rather than written beside it, so
 * the fields they share cannot drift apart.
 *
 * A recommendation that failed its grounding check carries **no partial
 * output** — no suggested title anyone might paste in, no half a section. What
 * it carries instead is one sentence of ours, sent as a key rather than as
 * prose, so the words the merchant reads are written in the string catalogue
 * and never by a model.
 */

export interface RecommendationViewField {
  readonly field: string
  readonly current: string | null
  readonly suggested: string
  readonly evidence: string | null
}

export interface RecommendationViewSection {
  readonly heading: string
  readonly copy: string
  readonly evidence: readonly string[]
}

export interface RecommendationViewFaq {
  readonly q: string
  readonly a: string
  readonly evidence: readonly string[]
}

export interface RecommendationViewReason {
  readonly templateKey: string
  readonly params: Readonly<Record<string, string | number>>
}

/** The whole of the generated advice for one page. */
export interface RecommendationView {
  readonly id: string
  readonly state: 'ready' | 'failed_validation'
  readonly pageUrl: string
  readonly fields: readonly RecommendationViewField[]
  readonly sections: readonly RecommendationViewSection[]
  readonly faq: readonly RecommendationViewFaq[]
  readonly internalLinksIn: readonly { readonly fromUrl: string; readonly anchor: string }[]
  readonly internalLinksOut: readonly { readonly toUrl: string; readonly anchor: string }[]
  readonly intentNote: string | null
  readonly failureReason: RecommendationViewReason | null
  readonly generatedAt: string
}

export type DrawerRecommendationField = RecommendationViewField

/**
 * The same advice as the drawer shows it: the fields, the links and the note,
 * without the sections, the questions or the row's own identity, which the
 * drawer has nowhere to put.
 */
export interface DrawerRecommendation {
  readonly state: 'none' | 'generating' | 'ready' | 'failed_validation'
  readonly fields: readonly DrawerRecommendationField[]
  readonly internalLinksIn: readonly { readonly fromUrl: string; readonly anchor: string }[]
  readonly internalLinksOut: readonly { readonly toUrl: string; readonly anchor: string }[]
  readonly intentNote: string | null
  readonly failureReason: RecommendationViewReason | null
}

/** The one sentence a merchant reads when we could not produce safe advice. */
export const OPTIMIZE_FAILED_VALIDATION_KEY = 'optimize.failedValidation.reason'

export const NO_RECOMMENDATION: DrawerRecommendation = {
  state: 'none',
  fields: [],
  internalLinksIn: [],
  internalLinksOut: [],
  intentNote: null,
  failureReason: null,
}

/**
 * The drawer's own state for an opportunity with a recommendation being
 * written. Held apart from the stored row's state on purpose: the row does not
 * exist yet while the job is running, so "generating" is a fact about the
 * opportunity rather than about a recommendation.
 */
export const GENERATING: DrawerRecommendation = { ...NO_RECOMMENDATION, state: 'generating' }

export interface StoredRecommendation {
  readonly id: string
  readonly pageUrl: string
  /** `valid` or `failed_validation`; a superseded row is never the one read back. */
  readonly state: string
  readonly recommendationJson: unknown
  readonly generatedAt: Date
}

export function isFailedRecommendation(row: Pick<StoredRecommendation, 'state'>): boolean {
  return row.state === 'failed_validation'
}

export function toRecommendationView(row: StoredRecommendation): RecommendationView {
  const generatedAt = row.generatedAt.toISOString()

  if (isFailedRecommendation(row)) {
    return {
      id: row.id,
      state: 'failed_validation',
      pageUrl: row.pageUrl,
      fields: [],
      sections: [],
      faq: [],
      internalLinksIn: [],
      internalLinksOut: [],
      intentNote: null,
      // A template key, never the model's own words and never the lint text:
      // the merchant gets one sentence written by us.
      failureReason: { templateKey: OPTIMIZE_FAILED_VALIDATION_KEY, params: {} },
      generatedAt,
    }
  }

  const recommendation = row.recommendationJson as OptimizeRecommendation
  return {
    id: row.id,
    state: 'ready',
    pageUrl: row.pageUrl,
    fields: [
      {
        field: 'title_tag',
        current: recommendation.title_tag.current,
        suggested: recommendation.title_tag.suggested,
        evidence: fieldRationale(recommendation.title_tag),
      },
      {
        field: 'meta_description',
        current: recommendation.meta_description.current,
        suggested: recommendation.meta_description.suggested,
        evidence: fieldRationale(recommendation.meta_description),
      },
    ],
    sections: recommendation.sections.map((section) => ({
      heading: section.heading,
      copy: section.suggested_copy,
      evidence: section.facts_used,
    })),
    faq: recommendation.faq.map((entry) => ({ q: entry.q, a: entry.a, evidence: entry.facts_used })),
    internalLinksIn: recommendation.internal_links.add_from.map((link) => ({
      fromUrl: link.url,
      anchor: link.anchor,
    })),
    internalLinksOut: recommendation.internal_links.add_to.map((link) => ({
      toUrl: link.url,
      anchor: link.anchor,
    })),
    intentNote: recommendation.intent_note,
    failureReason: null,
    generatedAt,
  }
}

/** The drawer's cut of the full view. Never assembled independently of it. */
export function narrowToDrawer(view: RecommendationView): DrawerRecommendation {
  return {
    state: view.state,
    fields: view.fields,
    internalLinksIn: view.internalLinksIn,
    internalLinksOut: view.internalLinksOut,
    intentNote: view.intentNote,
    failureReason: view.failureReason,
  }
}

export function toDrawerRecommendation(row: StoredRecommendation): DrawerRecommendation {
  return narrowToDrawer(toRecommendationView(row))
}

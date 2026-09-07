import { fieldRationale, type OptimizeRecommendation } from '../optimize/recommendation'

/**
 * The generated advice for one page, in the shape the opportunity drawer reads.
 *
 * A recommendation that failed its grounding check carries **no partial
 * output** — no suggested title anyone might paste in, no half a section. What
 * it carries instead is one sentence of ours, sent as a key rather than as
 * prose, so the words the merchant reads are written in the string catalogue
 * and never by a model.
 */

export interface DrawerRecommendationField {
  readonly field: string
  readonly current: string | null
  readonly suggested: string
  readonly evidence: string | null
}

export interface DrawerRecommendation {
  readonly state: 'none' | 'generating' | 'ready' | 'failed_validation'
  readonly fields: readonly DrawerRecommendationField[]
  readonly internalLinksIn: readonly { readonly fromUrl: string; readonly anchor: string }[]
  readonly internalLinksOut: readonly { readonly toUrl: string; readonly anchor: string }[]
  readonly intentNote: string | null
  readonly failureReason: {
    readonly templateKey: string
    readonly params: Readonly<Record<string, string | number>>
  } | null
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

export interface StoredRecommendation {
  /** `valid` or `failed_validation`; a superseded row is never the one read back. */
  readonly state: string
  readonly recommendationJson: unknown
}

/**
 * The drawer's own state for an opportunity with a recommendation being
 * written. Held apart from the stored row's state on purpose: the row does not
 * exist yet while the job is running, so "generating" is a fact about the
 * opportunity rather than about a recommendation.
 */
export const GENERATING: DrawerRecommendation = { ...NO_RECOMMENDATION, state: 'generating' }

export function toDrawerRecommendation(row: StoredRecommendation): DrawerRecommendation {
  if (row.state === 'failed_validation') {
    return { ...NO_RECOMMENDATION, state: 'failed_validation', failureReason: { templateKey: OPTIMIZE_FAILED_VALIDATION_KEY, params: {} } }
  }
  const recommendation = row.recommendationJson as OptimizeRecommendation
  return {
    state: 'ready',
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
  }
}

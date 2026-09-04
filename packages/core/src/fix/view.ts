import type { ConsolidationRecommendation } from './consolidation'

/**
 * The consolidation recommendation as the drawer shows it: three sections, in
 * the order the merchant has to act in — which page wins, which links move, and
 * whether a canonical tag is appropriate — plus the line that says we changed
 * nothing in their store.
 *
 * No sentence is built here. Every piece of prose is a key into the string
 * catalogue with the numbers it interpolates, exactly like an opportunity's
 * why-line, so the words stay in one file and out of the API's responses.
 */

export interface FixSectionLine {
  readonly templateKey: string
  readonly params: Readonly<Record<string, string | number>>
}

export interface FixSection {
  readonly kind: 'primary_url' | 'internal_links' | 'canonical'
  readonly headingKey: string
  readonly lines: readonly FixSectionLine[]
}

export interface FixRecommendationView {
  readonly kind: 'cannibalization_consolidation'
  readonly clusterHead: string
  readonly sections: readonly FixSection[]
  /** Sortiva does not change your theme or redirects — apply these in Shopify. */
  readonly trustLineKey: string
}

export const FIX_TRUST_LINE_KEY = 'fix.trustLine'

export function renderConsolidationView(
  recommendation: ConsolidationRecommendation,
): FixRecommendationView {
  const primaryLines: FixSectionLine[] = [
    {
      templateKey: 'fix.consolidation.primary.designate',
      params: { url: recommendation.primary.url },
    },
    {
      templateKey: recommendation.primaryReasonTemplateKey,
      params: recommendation.primaryReasonParams,
    },
    ...recommendation.secondary.map((page) => ({
      templateKey: 'fix.consolidation.primary.secondary',
      params: { url: page.url, sharePercent: Math.round(page.impressionShare * 100) },
    })),
  ]

  const linkLines: FixSectionLine[] =
    recommendation.linkRealignment.length > 0
      ? recommendation.linkRealignment.map((link) => ({
          templateKey: 'fix.consolidation.links.repoint',
          params: {
            fromUrl: link.fromUrl,
            currentTarget: link.currentTarget,
            suggestedTarget: link.suggestedTarget,
          },
        }))
      : // Silence here would read as "there is nothing to do", when what it
        // actually means is that we hold no record of a link into the pages
        // being demoted — navigation menus are not in what the store hands us.
        [{ templateKey: 'fix.consolidation.links.none', params: {} }]

  const canonicalLines: FixSectionLine[] = [
    ...recommendation.canonicalSuggestions.map((suggestion) => ({
      templateKey: 'fix.consolidation.canonical.suggest',
      params: { url: suggestion.url, target: suggestion.suggestedCanonicalTarget },
    })),
    ...recommendation.canonicalNotAdvisedFor.map((url) => ({
      templateKey: 'fix.consolidation.canonical.notAdvised',
      params: { url },
    })),
  ]

  return {
    kind: 'cannibalization_consolidation',
    clusterHead: recommendation.clusterHead,
    sections: [
      { kind: 'primary_url', headingKey: 'fix.consolidation.primary.heading', lines: primaryLines },
      { kind: 'internal_links', headingKey: 'fix.consolidation.links.heading', lines: linkLines },
      { kind: 'canonical', headingKey: 'fix.consolidation.canonical.heading', lines: canonicalLines },
    ],
    trustLineKey: FIX_TRUST_LINE_KEY,
  }
}

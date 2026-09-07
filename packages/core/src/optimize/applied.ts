import type { OptimizeRecommendation } from './recommendation'

/**
 * "Looks like you applied this — confirm?"
 *
 * Main §10.4 asks us to notice when a merchant has acted on a recommendation
 * rather than wait to be told, and to *ask* rather than assume. Nothing here
 * marks anything applied: it reports what changed on the page, and the merchant
 * confirms.
 *
 * The comparison is exact once whitespace and case are levelled, deliberately.
 * A looser rule would guess, and a wrong guess here is the product telling
 * someone they did work they did not do. Missing a hand-typed near-match costs
 * only the prompt, which is why the strict direction is the right one.
 */

export interface CurrentPageState {
  /**
   * Whether the store still serves this address.
   *
   * Part of the state rather than something the caller checks first, because
   * every field compared below survives the page being taken down — the title
   * and the headings are kept so a page the merchant puts back is restored
   * untouched — so the comparison goes on matching a page nobody can visit. A
   * caller left to work this out would work it out from the row being there,
   * and the row is always there.
   */
  readonly status: 'live' | 'gone'
  readonly seoTitle: string | null
  readonly seoDescription: string | null
  readonly headings: readonly string[]
}

export type AppliedSignal =
  | 'title_matches_suggestion'
  | 'meta_matches_suggestion'
  | 'suggested_heading_present'

export interface AppliedDetection {
  /** True when at least one suggestion is now visibly on the page. */
  readonly looksApplied: boolean
  readonly signals: readonly AppliedSignal[]
  /** The suggested headings that have since appeared, so the prompt can name one. */
  readonly headingsFound: readonly string[]
}

function normalise(value: string | null): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

export function detectApplied(
  recommendation: OptimizeRecommendation,
  page: CurrentPageState,
): AppliedDetection {
  // Asking someone to confirm they improved a page they have taken down is a
  // question with no true answer, and saying yes to it would start a
  // twenty-eight-day measurement of a page that serves nothing.
  if (page.status !== 'live') return { looksApplied: false, signals: [], headingsFound: [] }

  const signals: AppliedSignal[] = []

  const title = normalise(recommendation.title_tag.suggested)
  if (title !== '' && normalise(page.seoTitle) === title) signals.push('title_matches_suggestion')

  const meta = normalise(recommendation.meta_description.suggested)
  if (meta !== '' && normalise(page.seoDescription) === meta) signals.push('meta_matches_suggestion')

  const present = new Set(page.headings.map(normalise))
  const suggestedHeadings = [
    ...recommendation.headings.map((heading) => heading.text),
    ...recommendation.sections.map((section) => section.heading),
  ]
  const headingsFound = suggestedHeadings.filter((heading) => {
    const key = normalise(heading)
    return key !== '' && present.has(key)
  })
  if (headingsFound.length > 0) signals.push('suggested_heading_present')

  return { looksApplied: signals.length > 0, signals, headingsFound }
}

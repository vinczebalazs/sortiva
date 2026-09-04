import type { EvidenceFact } from '../contracts/opportunities'
import type { CannibalizationSignal } from '../signals/cannibalization'
import { type StorePageType, normalisePageUrl } from '../signals/types'

/**
 * The store is competing with itself for one search, and this is what we tell
 * the merchant to do about it.
 *
 * Everything here is worked out from measurements we already hold. No model is
 * asked anything, and nothing is written to the merchant's store — the output
 * is words: which of their pages should be the one that answers this search,
 * why that one, which links to re-point at it, and where a canonical tag would
 * be appropriate. Applying any of it is their move, in Shopify.
 */

/** One of the store's own pages turning up for the shared search. */
export interface CompetingPageFacts {
  readonly url: string
  readonly pageType: StorePageType
  /** This page's share of everything the store was shown for on this search, 0–1. */
  readonly impressionShare: number
  /** Average position over the window. Lower is better. */
  readonly position: number
}

export interface ConsolidationInput {
  /** The search the pages are competing for. */
  readonly clusterHead: string
  readonly competing: readonly CompetingPageFacts[]
  /**
   * The page Google led with in each week of the window. Used only to break a
   * tie; the stored evidence of an opportunity row does not carry it, so it is
   * optional and its absence simply removes one tie-break.
   */
  readonly weeklyLeaders?: readonly { readonly page: string }[]
  /**
   * Every page of the store and what it links out to. This is where the
   * realignment list comes from: a link that currently points at a page we are
   * asking them to demote is a link that should point at the primary instead.
   */
  readonly inventory?: readonly {
    readonly url: string
    readonly outboundInternalLinks: readonly string[]
  }[]
}

/**
 * Why this page and not one of the others, as a key the string catalogue turns
 * into a sentence. Never free text and never a model's words — the same rule
 * every user-facing "why" in this product follows.
 */
export type PrimaryReasonKey =
  | 'fix.consolidation.primary.mostShown'
  | 'fix.consolidation.primary.bestPosition'
  | 'fix.consolidation.primary.ledMostWeeks'
  | 'fix.consolidation.primary.onlyCandidate'

export interface ConsolidationPage extends CompetingPageFacts {
  readonly isPrimary: boolean
}

/** One link that points at a page we are asking them to stop promoting. */
export interface LinkRealignment {
  /** The page holding the link. */
  readonly fromUrl: string
  /** The competing page it currently points at. */
  readonly currentTarget: string
  /** The primary page it should point at instead. */
  readonly suggestedTarget: string
}

/**
 * Where declaring one page the canonical version of another is appropriate —
 * and it is not appropriate everywhere.
 *
 * A canonical tag tells Google two addresses are the *same page*, and Google
 * then drops one of them. Two collections covering the same ground are the same
 * page. A product and a collection are not: pointing a product's canonical at a
 * collection asks Google to remove that product from search entirely, which is
 * a far worse outcome than the cannibalization it was meant to cure. So a
 * canonical is only ever suggested between pages of the same kind; for the
 * rest, the primary designation and the link realignment are the whole
 * recommendation, and the merchant is told plainly why no canonical is offered.
 */
export interface CanonicalSuggestion {
  readonly url: string
  readonly suggestedCanonicalTarget: string
}

export interface ConsolidationRecommendation {
  readonly clusterHead: string
  readonly primary: ConsolidationPage
  readonly primaryReasonTemplateKey: PrimaryReasonKey
  readonly primaryReasonParams: Readonly<Record<string, string | number>>
  /** Everything else competing for the search, most-shown first. */
  readonly secondary: readonly ConsolidationPage[]
  readonly linkRealignment: readonly LinkRealignment[]
  readonly canonicalSuggestions: readonly CanonicalSuggestion[]
  /**
   * Competing pages that are a different kind of page from the primary, so no
   * canonical is offered for them. Named so the view can say so rather than
   * leave a silent gap.
   */
  readonly canonicalNotAdvisedFor: readonly string[]
}

function weeksLed(input: ConsolidationInput, url: string): number {
  return (input.weeklyLeaders ?? []).filter((week) => normalisePageUrl(week.page) === url).length
}

/**
 * The order the pages are considered in, best candidate first.
 *
 * Google's own behaviour decides it: the page it already shows the store's
 * searchers most often is the page it is closest to settling on, so making that
 * one the target is the shortest route out of the split. Ties fall to the
 * better average position, then to the page that led in the most weeks, then to
 * the address itself so the answer never depends on the order rows arrived in.
 */
function ranked(input: ConsolidationInput): CompetingPageFacts[] {
  return [...input.competing].sort(
    (a, b) =>
      b.impressionShare - a.impressionShare ||
      a.position - b.position ||
      weeksLed(input, b.url) - weeksLed(input, a.url) ||
      a.url.localeCompare(b.url),
  )
}

/** Which measurement actually separated the winner from the runner-up — so the sentence we show is the true reason, not a stock one. */
function reasonFor(
  input: ConsolidationInput,
  winner: CompetingPageFacts,
  runnerUp: CompetingPageFacts | undefined,
): { key: PrimaryReasonKey; params: Record<string, string | number> } {
  if (!runnerUp) {
    return { key: 'fix.consolidation.primary.onlyCandidate', params: { query: input.clusterHead } }
  }
  if (winner.impressionShare !== runnerUp.impressionShare) {
    return {
      key: 'fix.consolidation.primary.mostShown',
      params: {
        query: input.clusterHead,
        sharePercent: Math.round(winner.impressionShare * 100),
      },
    }
  }
  if (winner.position !== runnerUp.position) {
    return {
      key: 'fix.consolidation.primary.bestPosition',
      params: { query: input.clusterHead, position: Math.round(winner.position * 10) / 10 },
    }
  }
  return {
    key: 'fix.consolidation.primary.ledMostWeeks',
    params: { query: input.clusterHead, weeks: weeksLed(input, winner.url) },
  }
}

export class NoCompetingPagesError extends Error {
  constructor() {
    super('A consolidation recommendation needs at least one competing page.')
    this.name = 'NoCompetingPagesError'
  }
}

export function buildConsolidationRecommendation(
  input: ConsolidationInput,
): ConsolidationRecommendation {
  const order = ranked({ ...input, competing: input.competing.map((page) => ({ ...page, url: normalisePageUrl(page.url) })) })
  const winner = order[0]
  if (!winner) throw new NoCompetingPagesError()
  const rest = order.slice(1)
  const reason = reasonFor(input, winner, rest[0])

  const secondaryUrls = new Set(rest.map((page) => page.url))
  const linkRealignment: LinkRealignment[] = []
  for (const page of input.inventory ?? []) {
    const from = normalisePageUrl(page.url)
    // A competing page linking to another competing page is part of the same
    // problem, but telling a merchant to make a page link to itself is not
    // advice, so the primary is skipped as a source only for links at itself.
    for (const target of page.outboundInternalLinks) {
      const to = normalisePageUrl(target)
      if (!secondaryUrls.has(to)) continue
      if (from === winner.url && to === winner.url) continue
      linkRealignment.push({ fromUrl: from, currentTarget: to, suggestedTarget: winner.url })
    }
  }
  linkRealignment.sort(
    (a, b) => a.fromUrl.localeCompare(b.fromUrl) || a.currentTarget.localeCompare(b.currentTarget),
  )

  const canonicalSuggestions: CanonicalSuggestion[] = []
  const canonicalNotAdvisedFor: string[] = []
  for (const page of rest) {
    if (page.pageType === winner.pageType) {
      canonicalSuggestions.push({ url: page.url, suggestedCanonicalTarget: winner.url })
    } else {
      canonicalNotAdvisedFor.push(page.url)
    }
  }

  return {
    clusterHead: input.clusterHead,
    primary: { ...winner, isPrimary: true },
    primaryReasonTemplateKey: reason.key,
    primaryReasonParams: reason.params,
    secondary: rest.map((page) => ({ ...page, isPrimary: false })),
    linkRealignment,
    canonicalSuggestions,
    canonicalNotAdvisedFor,
  }
}

/** The detector's own output, straight in — the path the scan and the fixtures take. */
export function consolidationInputFromSignal(
  signal: CannibalizationSignal,
  inventory?: ConsolidationInput['inventory'],
): ConsolidationInput {
  return {
    clusterHead: signal.clusterHead,
    competing: signal.competing.map((page) => ({
      url: page.page,
      pageType: page.pageType,
      impressionShare: page.impressionShare,
      position: page.position,
    })),
    weeklyLeaders: signal.weeklyLeaders,
    ...(inventory ? { inventory } : {}),
  }
}

const PAGE_TYPES: readonly StorePageType[] = [
  'collection',
  'product',
  'page',
  'blog_article',
  'article_ours',
  'other',
]

function numeric(value: EvidenceFact['value'] | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

/**
 * The same recommendation rebuilt from an opportunity row days after the scan
 * that found it.
 *
 * The detector's own object is not kept — the row carries its evidence, and the
 * evidence is what the merchant is shown — so this reads the competing pages
 * back out of the facts the cannibalization detector wrote (`competing_page_1`,
 * its share, its position, its kind, and so on). Anything missing a share or a
 * position is dropped rather than guessed at: a page we cannot say a number
 * about cannot be argued for or against.
 */
export function consolidationInputFromEvidence(
  evidence: readonly EvidenceFact[],
  inventory?: ConsolidationInput['inventory'],
): ConsolidationInput | null {
  const byKey = new Map(evidence.map((fact) => [fact.key, fact.value]))
  const clusterHead = byKey.get('query_cluster')
  if (typeof clusterHead !== 'string' || clusterHead === '') return null

  const competing: CompetingPageFacts[] = []
  for (let index = 1; ; index += 1) {
    const url = byKey.get(`competing_page_${index}`)
    if (typeof url !== 'string' || url === '') break
    const impressionShare = numeric(byKey.get(`competing_page_${index}_impression_share`))
    const position = numeric(byKey.get(`competing_page_${index}_position`))
    const rawType = byKey.get(`competing_page_${index}_type`)
    if (impressionShare === null || position === null) continue
    const pageType = PAGE_TYPES.find((candidate) => candidate === rawType) ?? 'other'
    competing.push({ url: normalisePageUrl(url), pageType, impressionShare, position })
  }
  if (competing.length === 0) return null

  return { clusterHead, competing, ...(inventory ? { inventory } : {}) }
}

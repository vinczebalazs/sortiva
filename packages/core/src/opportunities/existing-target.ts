import type { EvidenceFact, ExistingTargetOutcome, QueryCluster } from '../contracts/opportunities'
import { GSC_SOURCE, INVENTORY_SOURCE, facts, normalisePageUrl } from '../signals/types'
import { normaliseQuery } from '../search/clusters'
import type { ExistingCoverage } from '../signals/candidates'
import { mintCreateClearance, type CreateClearance } from './clearance'
import type { ExistingTargetInput, ExistingTargetPage, PagePresence } from './ports'

/**
 * "Do we already have a page for this?" — asked before anything new is written,
 * and the same question the topic gate asks at admission.
 *
 * One function, called from both places on purpose. Two functions that agreed
 * today would drift, and the day they disagreed the product would publish a
 * second page competing with a page the merchant already has — which looks like
 * nothing at all from the outside. The store keeps two pages splitting one
 * search between them, neither wins, and no error is ever raised.
 *
 * Three ways to find that page, in the order the answer is trusted:
 *
 * 1. **What Google actually did.** A page of ours already shown for this intent,
 *    ranking well enough to be worth improving, is the strongest possible
 *    evidence that the store covers the subject.
 * 2. **What the store publishes.** A collection or article whose products and
 *    purpose match the intent is a target even if Google has not settled on it
 *    yet — silence from Search Console is not evidence of absence.
 * 3. **What the vendor says**, for a store with no Search Console connection at
 *    all. A third party's sample of what the domain ranks for: weaker, named as
 *    such in the evidence, and only consulted when there is nothing better.
 *
 * A page found this way takes the work over — the merchant is told to improve
 * what they have. A page found but too weak to take it over does not block the
 * new one; it gets linked to it instead, so the two support each other rather
 * than competing.
 */

/** How firmly the found page owns this intent. */
export type MatchStrength = 'none' | 'weak' | 'strong'

/** Which of the three lookups produced the answer. */
export type MatchSource = 'gsc' | 'content_mapping' | 'limited_intelligence'

/** Why a page that was found could not take the work over. */
export type WeaknessReason =
  /** It ranks, but too far back for improving it to be the better bet. */
  | 'position_beyond_match_band'
  /** A single product's page cannot serve a subject that spans a range. */
  | 'product_page_for_category_intent'
  /**
   * Its products match, but nothing has established what the page is *for*, so
   * we will not hand it work it may not be able to do.
   */
  | 'page_intent_unknown'

export interface ExistingTargetMatch {
  readonly url: string
  readonly strength: Exclude<MatchStrength, 'none'>
  readonly via: MatchSource
  /** Mean position over the window, where a source supplied one. */
  readonly position: number | null
  readonly pageType: ExistingTargetPage['pageType'] | null
  /** Set on a weak match, and the reason the new page still needs a link back to this one. */
  readonly weakness: WeaknessReason | null
  /**
   * Whether the store still publishes this address, as the last completed walk
   * of the store found it. A match is never `removed` — a page the store has
   * taken down cannot be a target — so this reads `published` on anything that
   * came from the inventory, and `unknown` on a match Search Console or the
   * search vendor named that the inventory has no row for.
   */
  readonly presence: PagePresence
}

/**
 * The full answer, for callers inside this lane.
 *
 * Richer than the cross-lane contract, which carries only what the topic gate
 * needs to decide. The evidence and the presence reading matter to the
 * opportunity row that gets written, and folding them into the frozen seam
 * would mean re-freezing it for two consumers that do not need them.
 */
export interface ExistingTargetResult {
  readonly match: ExistingTargetMatch | null
  /**
   * Non-null exactly when a new page may be proposed. Carries the link tasks a
   * weak match requires, so honouring the match and honouring the link cannot
   * come apart.
   */
  readonly clearance: CreateClearance | null
  readonly evidence: readonly EvidenceFact[]
  /** True when the answer rests on the vendor proxy rather than on Search Console. */
  readonly limitedIntelligence: boolean
}

/** The vendor proxy is a source of its own, named so evidence can say where a number came from. */
const PROXY_SOURCE = 'dataforseo'

function pageIndex(pages: readonly ExistingTargetPage[]): Map<string, ExistingTargetPage> {
  const out = new Map<string, ExistingTargetPage>()
  for (const page of pages) out.set(normalisePageUrl(page.url), page)
  return out
}

/**
 * A page the store has taken down cannot be a target: there is nothing left to
 * improve, and holding it against a new page keeps the store short of coverage
 * it no longer has.
 *
 * Only a removal the walk actually established counts. Everything else —
 * a page we hold no row for, a page seen by Search Console but not by the
 * inventory — reads as present, which is the safe direction: treating a live
 * page as gone is what puts two of our own pages in front of one search.
 */
function stillPublished(page: ExistingTargetPage | undefined): boolean {
  return page?.presence !== 'removed'
}

/** Does this page serve the same subject as the intent we are about to write for? */
function coversIntent(
  page: ExistingTargetPage,
  cluster: QueryCluster,
): 'same' | 'unknown' | 'different' {
  const sharesFamily = page.familyIds.some((id) => cluster.familyIds.includes(id))
  if (!sharesFamily) return 'different'
  if (page.intentClass === null) return 'unknown'
  return page.intentClass === cluster.intentClass ? 'same' : 'different'
}

/**
 * Every intent class we write for — buying guide, comparison, how-to,
 * explainer — is a subject broader than one item, so a single product's page is
 * never the right target for one however well it ranks. It is a supporting
 * asset, which is exactly what the link task turns it into.
 */
function weaknessFor(
  pageType: ExistingTargetPage['pageType'] | null,
  position: number | null,
  matchPositionMax: number,
): WeaknessReason | null {
  if (pageType === 'product') return 'product_page_for_category_intent'
  if (position !== null && position > matchPositionMax) return 'position_beyond_match_band'
  return null
}

function candidateFor(
  url: string,
  position: number | null,
  via: MatchSource,
  page: ExistingTargetPage | undefined,
  extraWeakness: WeaknessReason | null,
  matchPositionMax: number,
): ExistingTargetMatch {
  const weakness = weaknessFor(page?.pageType ?? null, position, matchPositionMax) ?? extraWeakness
  return {
    url,
    strength: weakness ? 'weak' : 'strong',
    via,
    position,
    pageType: page?.pageType ?? null,
    weakness,
    presence: page?.presence ?? 'unknown',
  }
}

/** (a) What Google already shows for this intent. */
function fromSearchConsole(
  input: ExistingTargetInput,
  pages: Map<string, ExistingTargetPage>,
): ExistingTargetMatch[] {
  const out: ExistingTargetMatch[] = []
  for (const row of input.rankedPages) {
    if (!row.impressions) continue
    if (row.position === null) continue
    const url = normalisePageUrl(row.url)
    const page = pages.get(url)
    if (!stillPublished(page)) continue
    out.push(candidateFor(url, row.position, 'gsc', page, null, input.config.match_position_max))
  }
  return out
}

/** (b) What the store publishes, whether or not Google has settled on it. */
function fromContentMapping(
  input: ExistingTargetInput,
  alreadyMeasured: ReadonlySet<string>,
): ExistingTargetMatch[] {
  const out: ExistingTargetMatch[] = []
  for (const page of input.pages) {
    const url = normalisePageUrl(page.url)
    // Search Console has already told us how this page does on this intent, and
    // a measurement beats an inference about the same page every time. Content
    // mapping is here to speak for the pages Google has said nothing about.
    if (alreadyMeasured.has(url)) continue
    if (!stillPublished(page)) continue

    const covers = coversIntent(page, input.cluster)
    if (covers === 'different') continue

    out.push(
      candidateFor(
        url,
        null,
        'content_mapping',
        page,
        // A page whose purpose nobody has established yet is a candidate, not a
        // conclusion. Enough to stop us writing blind — the new page has to link
        // to it — and not enough to hand it work it may not be able to do.
        covers === 'unknown' ? 'page_intent_unknown' : null,
        input.config.match_position_max,
      ),
    )
  }
  return out
}

/** (c) The vendor's account of this domain, for a store with no Search Console. */
function fromProxy(
  input: ExistingTargetInput,
  pages: Map<string, ExistingTargetPage>,
  alreadyMeasured: ReadonlySet<string>,
): ExistingTargetMatch[] {
  const wanted = new Set(
    [input.cluster.head, ...input.cluster.members].map(normaliseQuery).filter(Boolean),
  )

  const best = new Map<string, number>()
  for (const row of input.proxyRankings) {
    if (!wanted.has(normaliseQuery(row.keyword))) continue
    const url = normalisePageUrl(row.url)
    if (alreadyMeasured.has(url)) continue
    if (!stillPublished(pages.get(url))) continue
    const seen = best.get(url)
    if (seen === undefined || row.position < seen) best.set(url, row.position)
  }

  return [...best.entries()].map(([url, position]) =>
    candidateFor(url, position, 'limited_intelligence', pages.get(url), null, input.config.match_position_max),
  )
}

const SOURCE_ORDER: Record<MatchSource, number> = {
  gsc: 0,
  content_mapping: 1,
  limited_intelligence: 2,
}

/**
 * Picks the page the work should go to.
 *
 * A page that plainly serves the intent wins over one that barely ranks, and
 * where two are equally good the more trustworthy source, then the better
 * position, then the address in alphabetical order decides — so the same store
 * gets the same answer every week rather than converting to improvement work one
 * week and to a new page the next.
 */
function strongestMatch(candidates: readonly ExistingTargetMatch[]): ExistingTargetMatch | null {
  const ordered = [...candidates].sort((a, b) => {
    if (a.strength !== b.strength) return a.strength === 'strong' ? -1 : 1
    if (a.via !== b.via) return SOURCE_ORDER[a.via] - SOURCE_ORDER[b.via]
    const ap = a.position ?? Number.POSITIVE_INFINITY
    const bp = b.position ?? Number.POSITIVE_INFINITY
    if (ap !== bp) return ap - bp
    return a.url.localeCompare(b.url)
  })
  return ordered[0] ?? null
}

function windowToken(config: ExistingTargetInput['config']): string {
  return `${config.window_days}d`
}

function sourceOf(via: MatchSource): string {
  if (via === 'gsc') return GSC_SOURCE
  if (via === 'content_mapping') return INVENTORY_SOURCE
  return PROXY_SOURCE
}

/**
 * Runs the check for one intent.
 *
 * All three lookups run and the best page wins, but they do not overlap:
 * Search Console's reading of a page is final for that page, and the other two
 * speak only for pages Google has said nothing about. That is what keeps both
 * halves of the rule true at once — a collection that plainly serves the subject
 * is not hidden by some unrelated page ranking at 88, and a collection ranking
 * at 61 is not promoted back to a strong match by the fact that we can see what
 * it sells.
 */
export function findExistingTarget(input: ExistingTargetInput): ExistingTargetResult {
  const pages = pageIndex(input.pages)

  const measured = fromSearchConsole(input, pages)
  const measuredUrls = new Set(measured.map((m) => m.url))
  const candidates = [
    ...measured,
    ...fromContentMapping(input, measuredUrls),
    ...(input.limitedIntelligence ? fromProxy(input, pages, measuredUrls) : []),
  ]

  const match = strongestMatch(candidates)

  const token = windowToken(input.config)
  const evidence = facts(input.fetchedAt, [
    { key: 'query_cluster', value: input.cluster.head, source: INVENTORY_SOURCE },
    { key: 'existing_target_match', value: match?.strength ?? 'none', source: INVENTORY_SOURCE },
    ...(match
      ? [
          { key: 'existing_target_url', value: match.url, source: sourceOf(match.via), window: token },
          { key: 'existing_target_via', value: match.via, source: sourceOf(match.via) },
          ...(match.position !== null
            ? [
                {
                  key: 'existing_target_position',
                  value: match.position,
                  source: sourceOf(match.via),
                  window: token,
                },
              ]
            : []),
          ...(match.weakness ? [{ key: 'existing_target_weakness', value: match.weakness, source: INVENTORY_SOURCE }] : []),
          // Recorded rather than assumed: nothing yet confirms a page the
          // merchant deleted is gone, so a card built from this evidence can
          // say the page's continued existence is unverified.
          { key: 'existing_target_presence', value: match.presence, source: INVENTORY_SOURCE },
        ]
      : []),
  ])

  // A strong match takes the work over, so there is nothing to clear. Anything
  // else clears the new page — and a weak match takes its link task with it, so
  // the two halves of that rule travel together.
  const clearance =
    match?.strength === 'strong'
      ? null
      : mintCreateClearance({
          clusterHead: input.cluster.head,
          checkedAt: input.fetchedAt,
          weakExistingTarget: match?.url ?? null,
        })

  return { match, clearance, evidence, limitedIntelligence: input.limitedIntelligence }
}

/**
 * The same answer in the shape the frozen cross-lane seam speaks.
 *
 * The seam names an action because its consumer — the topic gate — has to know
 * whether the work becomes improving a store page or rewriting one of our own
 * articles. Our own published articles are the only thing we rewrite; the
 * merchant's own pages we recommend changes to.
 */
export function toContractOutcome(result: ExistingTargetResult): ExistingTargetOutcome {
  const { match } = result
  if (!match) return { match: 'none' }

  if (match.strength === 'weak') {
    return {
      match: 'weak',
      url: match.url,
      action: 'CREATE_WITH_LINK',
      via: match.via,
      ...(match.position !== null ? { position: match.position } : {}),
    }
  }

  return {
    match: 'strong',
    url: match.url,
    action: match.pageType === 'article_ours' ? 'REFRESH' : 'OPTIMIZE',
    via: match.via,
    ...(match.position !== null ? { position: match.position } : {}),
  }
}

/**
 * The same answer in the shape a detector reads.
 *
 * The third and last shape of one answer, and the only route by which a
 * detector can obtain a clearance: a detector that was never given a checked
 * answer has nothing that will satisfy the guard on a new-page recommendation.
 * A hand-built object gets no further — the clearance inside carries a marker
 * only the mint above can put there.
 */
export function toCoverageAnswer(result: ExistingTargetResult): ExistingCoverage {
  const { match } = result
  if (!match) return { strength: 'none', clearance: result.clearance }
  return {
    strength: match.strength,
    url: match.url,
    pageType: match.pageType,
    position: match.position,
    clearance: result.clearance,
  }
}

/** The check as the rest of the engine calls it: one function, one answer, both shapes. */
export function existingTargetCheck(input: ExistingTargetInput): {
  readonly result: ExistingTargetResult
  readonly outcome: ExistingTargetOutcome
} {
  const result = findExistingTarget(input)
  return { result, outcome: toContractOutcome(result) }
}

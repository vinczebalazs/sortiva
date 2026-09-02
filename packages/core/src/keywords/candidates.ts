import { isBlocklistedDomain } from './blocklist'

/**
 * Which domains keep turning up when this shop's customers search — the one
 * calculation behind both places a domain is ever named to a merchant.
 *
 * There are two of those places and they must not drift apart, which is why
 * this is a single function rather than two similar ones:
 *
 * - **Onboarding's draft list.** Before the merchant has looked at anything,
 *   the top few candidates are proposed as business competitors so the
 *   confirmation screen has something to show. They are a draft: the merchant
 *   removes what they disagree with before confirming, and every row is badged
 *   as ours rather than theirs.
 * - **The standing suggestion feed.** Afterwards, a domain ranking against the
 *   store's *confirmed* terms is offered underneath the list with an add
 *   button. Nothing here writes it; adding is the merchant's click.
 *
 * What never happens on either path is the thing the separation exists for: the
 * per-query cast of whoever occupies a results page — publishers, forums,
 * marketplaces, a competitor's reseller — stays inside the stored results page
 * and is never promoted into the competitor list on its own. That set is
 * unbounded and not the merchant's to manage; this one is capped, badged and
 * theirs. A domain crosses from the first to the second only by appearing for
 * enough different searches to be a pattern rather than a coincidence, and even
 * then only as a name on a screen.
 */

/** One domain seen ranking for one of the store's searches. */
export interface RankedDomain {
  readonly keyword: string
  readonly domain: string
  readonly position: number
}

export interface CompetitorCandidate {
  /** The registrable domain, normalised. */
  readonly domain: string
  /** How many distinct searches of the store's this domain ranked for. */
  readonly appearsInKeywords: number
  /** The searches themselves, so the merchant can be told which ones. */
  readonly keywords: readonly string[]
  /** Its best position across those searches. Breaks ties between equally frequent domains. */
  readonly bestPosition: number
}

export interface RankCompetitorCandidatesInput {
  readonly ranked: readonly RankedDomain[]
  /** The store's own domain, normalised. Never a candidate. */
  readonly ownDomain: string
  /** Domains already on the merchant's list, normalised. Never proposed twice. */
  readonly existingDomains?: readonly string[]
  /** From `packages/rules`: how deep into the results page still counts as ranking. */
  readonly positionMax: number
  /** From `packages/rules`: how many distinct searches a domain must appear for. */
  readonly appearsInKeywordsMin: number
  /** How many to return. Callers pass the ceiling that applies to them. */
  readonly limit: number
}

/**
 * Ranked by how many of the store's searches the domain appears for, then by
 * how high it got, then alphabetically so the answer is stable for a given
 * input rather than dependent on iteration order.
 */
export function rankCompetitorCandidates(
  input: RankCompetitorCandidatesInput,
): CompetitorCandidate[] {
  const own = normaliseHost(input.ownDomain)
  const existing = new Set((input.existingDomains ?? []).map(normaliseHost))

  const byDomain = new Map<string, { keywords: Set<string>; bestPosition: number }>()

  for (const row of input.ranked) {
    if (row.position > input.positionMax) continue
    const domain = normaliseHost(row.domain)
    if (domain === '') continue
    if (domain === own || domain.endsWith(`.${own}`)) continue
    if (existing.has(domain)) continue
    if (isBlocklistedDomain(domain)) continue

    const seen = byDomain.get(domain)
    if (seen) {
      seen.keywords.add(row.keyword)
      seen.bestPosition = Math.min(seen.bestPosition, row.position)
    } else {
      byDomain.set(domain, { keywords: new Set([row.keyword]), bestPosition: row.position })
    }
  }

  return [...byDomain.entries()]
    .map(([domain, seen]) => ({
      domain,
      appearsInKeywords: seen.keywords.size,
      keywords: [...seen.keywords].sort(),
      bestPosition: seen.bestPosition,
    }))
    .filter((candidate) => candidate.appearsInKeywords >= input.appearsInKeywordsMin)
    .sort(
      (a, b) =>
        b.appearsInKeywords - a.appearsInKeywords ||
        a.bestPosition - b.bestPosition ||
        a.domain.localeCompare(b.domain),
    )
    .slice(0, Math.max(0, input.limit))
}

/** Lower-cased, `www.` and a trailing dot removed. The vendor reports hosts, not registrable domains. */
export function normaliseHost(domain: string): string {
  let host = domain.trim().toLowerCase()
  while (host.endsWith('.')) host = host.slice(0, -1)
  if (host.startsWith('www.')) host = host.slice(4)
  return host
}

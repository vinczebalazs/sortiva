/**
 * One piece of work per page, not one per search.
 *
 * A collection can sit just off page one for a dozen phrasings of the same
 * thing. That is one job — improve the collection — and showing it a dozen
 * times would bury everything else in the merchant's list. It is also what the
 * database allows: only one open opportunity may exist per store per signal per
 * page, so two detections on one page could not both survive anyway; they would
 * overwrite each other in whatever order they happened to be written.
 *
 * So each page keeps its strongest candidate — the intent it is shown for most
 * — and the count of the others travels with it as evidence, because "and nine
 * more searches like it" is part of why the page is worth the merchant's time.
 */

export interface PageCandidate {
  readonly page: string
  /** How much the store was shown for this intent on this page, which is what "strongest" means. */
  readonly clusterImpressions: number
  readonly clusterHead: string
}

export interface StrongestPerPage<T extends PageCandidate> {
  readonly winner: T
  /** How many other intents on this page also cleared the same test. */
  readonly alsoQualified: number
}

export function strongestPerPage<T extends PageCandidate>(
  candidates: readonly T[],
): StrongestPerPage<T>[] {
  const byPage = new Map<string, T[]>()
  for (const candidate of candidates) {
    const existing = byPage.get(candidate.page)
    if (existing) existing.push(candidate)
    else byPage.set(candidate.page, [candidate])
  }

  const out: StrongestPerPage<T>[] = []
  for (const group of byPage.values()) {
    // Ties break on the head search's text so that the same data always yields
    // the same card, whatever order the rows arrived in.
    const sorted = [...group].sort(
      (a, b) =>
        b.clusterImpressions - a.clusterImpressions || a.clusterHead.localeCompare(b.clusterHead),
    )
    const winner = sorted[0]
    if (!winner) continue
    out.push({ winner, alsoQualified: sorted.length - 1 })
  }

  return out.sort(
    (a, b) =>
      b.winner.clusterImpressions - a.winner.clusterImpressions ||
      a.winner.page.localeCompare(b.winner.page),
  )
}
